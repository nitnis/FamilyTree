/* ---------------------------------------------------------------
   drive.js — keep the tree in a Google Drive file.

   A share URL on its own is not enough to save anything: Drive writes
   need an OAuth access token, and the drive.google.com download
   endpoint sends no CORS headers. So the URL only tells us *which*
   file to use; the writing is done through the Drive REST API with a
   token obtained by Google Identity Services.

   Because this app is static and has no server to hold a secret, the
   OAuth client ID is supplied by the user and kept in localStorage
   alongside the link. A client ID is not a credential on its own — it
   is safe in the page, and Google enforces which origins may use it.
   --------------------------------------------------------------- */
(function (window) {
  'use strict';

  var CONFIG_KEY = 'kinfolk.drive.v1';
  var GIS_SRC = 'https://accounts.google.com/gsi/client';

  // A file pasted as a URL was not created by this app, so the narrow
  // drive.file scope cannot reach it — that scope only covers files the app
  // itself created or the user opened through the Google Picker.
  var SCOPE = 'https://www.googleapis.com/auth/drive';

  var API = 'https://www.googleapis.com/drive/v3/files/';
  var UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files/';

  var SAVE_DEBOUNCE = 2000;

  var Drive = {
    config: null,        // { clientId, fileId, name, url }
    status: 'unlinked',  // unlinked | connecting | synced | pending | saving | error
    message: '',
    lastSaved: 0,

    _token: null,
    _expires: 0,
    _tokenClient: null,
    _gisPromise: null,
    _timer: null,
    _pending: null,      // the getter for the next save
    _inFlight: false,
    _listeners: [],

    /* ----------------------------- config ----------------------------- */

    restore: function () {
      try {
        var raw = window.localStorage.getItem(CONFIG_KEY);
        if (raw) {
          var cfg = JSON.parse(raw);
          if (cfg && cfg.fileId && cfg.clientId) {
            this.config = cfg;
            this.status = 'pending';
          }
        }
      } catch (err) { /* storage unavailable — stay unlinked */ }
      return this.config;
    },

    persist: function () {
      try {
        if (this.config) window.localStorage.setItem(CONFIG_KEY, JSON.stringify(this.config));
        else window.localStorage.removeItem(CONFIG_KEY);
      } catch (err) { /* ignore */ }
    },

    isLinked: function () { return !!(this.config && this.config.fileId); },

    onChange: function (fn) { this._listeners.push(fn); },

    _emit: function (status, message) {
      if (status) this.status = status;
      this.message = message || '';
      for (var i = 0; i < this._listeners.length; i++) this._listeners[i](this);
    },

    /** Pull a file id out of whatever shape of Drive link was pasted. */
    parseFileId: function (input) {
      var text = String(input || '').trim();
      if (!text) return '';
      var patterns = [
        /\/d\/([a-zA-Z0-9_-]{10,})/,          // /file/d/ID/view, /document/d/ID/edit
        /[?&]id=([a-zA-Z0-9_-]{10,})/,        // ?id=ID, uc?export=download&id=ID
        /\/folders\/([a-zA-Z0-9_-]{10,})/
      ];
      for (var i = 0; i < patterns.length; i++) {
        var m = text.match(patterns[i]);
        if (m) return m[1];
      }
      if (/^[a-zA-Z0-9_-]{10,}$/.test(text)) return text;   // a bare id
      return '';
    },

    /* ------------------------------ auth ------------------------------ */

    _loadGis: function () {
      if (window.google && window.google.accounts && window.google.accounts.oauth2) {
        return Promise.resolve();
      }
      if (this._gisPromise) return this._gisPromise;
      this._gisPromise = new Promise(function (resolve, reject) {
        var s = document.createElement('script');
        s.src = GIS_SRC;
        s.async = true;
        s.onload = function () { resolve(); };
        s.onerror = function () {
          reject(new Error('Could not reach Google sign-in. Check your connection.'));
        };
        document.head.appendChild(s);
      });
      return this._gisPromise;
    },

    /**
     * Get an access token. `interactive` shows Google's consent screen;
     * otherwise we try silently and fail if consent has not been given.
     */
    token: function (interactive) {
      var self = this;
      if (this._token && Date.now() < this._expires) return Promise.resolve(this._token);
      if (!this.config || !this.config.clientId) {
        return Promise.reject(new Error('No Google client ID configured.'));
      }

      return this._loadGis().then(function () {
        return new Promise(function (resolve, reject) {
          var oauth2 = window.google.accounts.oauth2;
          if (!self._tokenClient || self._tokenClient.__clientId !== self.config.clientId) {
            self._tokenClient = oauth2.initTokenClient({
              client_id: self.config.clientId,
              scope: SCOPE,
              callback: function () { /* replaced per request below */ }
            });
            self._tokenClient.__clientId = self.config.clientId;
          }

          self._tokenClient.callback = function (resp) {
            if (resp && resp.access_token) {
              self._token = resp.access_token;
              // Renew a minute early so a save never starts on a dead token.
              self._expires = Date.now() + ((resp.expires_in || 3600) - 60) * 1000;
              resolve(self._token);
            } else {
              reject(new Error(describeAuthError(resp)));
            }
          };
          self._tokenClient.error_callback = function (err) {
            reject(new Error(describeAuthError(err)));
          };

          try {
            self._tokenClient.requestAccessToken({ prompt: interactive ? 'consent' : '' });
          } catch (err) {
            reject(err);
          }
        });
      });
    },

    /** Forget the cached token so the next call re-authorises. */
    forgetToken: function () {
      this._token = null;
      this._expires = 0;
    },

    /* ------------------------------- api ------------------------------- */

    _fetch: function (url, opts, interactive) {
      var self = this;
      return this.token(interactive).then(function (token) {
        var init = Object.assign({}, opts || {});
        init.headers = Object.assign({}, init.headers, { Authorization: 'Bearer ' + token });
        return window.fetch(url, init).then(function (res) {
          if (res.status === 401) {
            // Token rejected mid-session: drop it and try once more.
            self.forgetToken();
            return self.token(false).then(function (fresh) {
              init.headers.Authorization = 'Bearer ' + fresh;
              return window.fetch(url, init);
            });
          }
          return res;
        });
      }).then(function (res) {
        if (!res.ok) return describeHttpError(res).then(function (msg) { throw new Error(msg); });
        return res;
      });
    },

    meta: function (interactive) {
      var id = this.config.fileId;
      return this._fetch(
        API + encodeURIComponent(id) + '?fields=id,name,mimeType,modifiedTime,size',
        { method: 'GET' },
        interactive
      ).then(function (res) { return res.json(); });
    },

    read: function (interactive) {
      var id = this.config.fileId;
      return this._fetch(
        API + encodeURIComponent(id) + '?alt=media',
        { method: 'GET' },
        interactive
      ).then(function (res) { return res.text(); });
    },

    write: function (text, opts) {
      var id = this.config.fileId;
      var init = {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: text
      };
      // keepalive lets a last save survive the page closing.
      if (opts && opts.keepalive) init.keepalive = true;
      return this._fetch(
        UPLOAD + encodeURIComponent(id) + '?uploadType=media&fields=id,modifiedTime',
        init,
        false
      ).then(function (res) { return res.json(); });
    },

    /* ------------------------------ linking ---------------------------- */

    /**
     * Attach to a Drive file. Resolves with the file's metadata and whatever
     * tree it already holds, so the caller can decide which side wins before
     * anything is overwritten.
     */
    link: function (fields) {
      var self = this;
      var fileId = this.parseFileId(fields.url);
      if (!fileId) {
        return Promise.reject(new Error('That does not look like a Google Drive file link.'));
      }

      var previous = this.config;
      this.config = {
        clientId: String(fields.clientId || '').trim(),
        fileId: fileId,
        name: String(fields.name || '').trim() || 'Drive file',
        url: String(fields.url || '').trim()
      };
      this.forgetToken();
      this._emit('connecting', 'Connecting to Google Drive…');

      return this.meta(true).then(function (meta) {
        return self.read(false).then(function (text) {
          return { meta: meta, text: text };
        }, function () {
          return { meta: meta, text: '' };     // empty or unreadable body
        });
      }).then(function (result) {
        var remote = null;
        if (result.text && result.text.trim()) {
          try {
            var parsed = JSON.parse(result.text);
            if (parsed && Array.isArray(parsed.people)) remote = parsed;
          } catch (err) { /* not a tree — caller is told via remote:null */ }
        }
        self.persist();
        self._emit('pending', '');
        return { meta: result.meta, remote: remote, hadContent: !!(result.text && result.text.trim()) };
      }, function (err) {
        self.config = previous;               // roll back a failed link
        self.forgetToken();
        self._emit(previous ? 'pending' : 'unlinked', err.message);
        throw err;
      });
    },

    unlink: function () {
      this.config = null;
      this.forgetToken();
      this.persist();
      this.cancelPending();
      this._emit('unlinked', '');
    },

    /* ------------------------------ saving ----------------------------- */

    cancelPending: function () {
      if (this._timer) window.clearTimeout(this._timer);
      this._timer = null;
      this._pending = null;
    },

    /** Adopt the remote copy as the current state: drop any queued save so
        the bytes just read are not written straight back. */
    markSynced: function () {
      this.cancelPending();
      this._emit('synced', '');
    },

    /**
     * Queue a save. Called on every edit, so it debounces and keeps only the
     * newest snapshot — a burst of drags becomes one upload.
     */
    schedule: function (getText) {
      if (!this.isLinked()) return;
      this._pending = getText;
      this._emit('pending', '');
      if (this._timer) window.clearTimeout(this._timer);
      var self = this;
      this._timer = window.setTimeout(function () { self.flush(); }, SAVE_DEBOUNCE);
    },

    /** Send the queued save now. */
    flush: function (opts) {
      var self = this;
      if (this._timer) { window.clearTimeout(this._timer); this._timer = null; }
      if (!this.isLinked() || !this._pending) return Promise.resolve(false);
      if (this._inFlight) return Promise.resolve(false);   // the tail call below picks it up

      var getText = this._pending;
      this._pending = null;
      this._inFlight = true;
      this._emit('saving', '');

      return this.write(getText(), opts).then(function () {
        self._inFlight = false;
        self.lastSaved = Date.now();
        if (self._pending) {           // edits landed while uploading
          self._emit('pending', '');
          self.schedule(self._pending);
        } else {
          self._emit('synced', '');
        }
        return true;
      }, function (err) {
        self._inFlight = false;
        self._pending = getText;       // keep it so a retry can still save
        self._emit('error', err.message);
        return false;
      });
    },

    hasUnsaved: function () { return !!this._pending; }
  };

  /* ------------------------------- errors ------------------------------- */

  function describeAuthError(resp) {
    var type = resp && (resp.type || resp.error);
    if (type === 'popup_closed' || type === 'popup_closed_by_user') {
      return 'Google sign-in was closed before finishing.';
    }
    if (type === 'popup_failed_to_open') {
      return 'The browser blocked the Google sign-in popup. Allow popups for this site and try again.';
    }
    if (type === 'access_denied') return 'Access to Google Drive was declined.';
    if (resp && resp.error_description) return resp.error_description;
    if (type) return 'Google sign-in failed (' + type + ').';
    return 'Google sign-in failed.';
  }

  function describeHttpError(res) {
    return res.text().then(function (body) {
      var detail = '';
      try {
        var parsed = JSON.parse(body);
        detail = parsed && parsed.error && parsed.error.message ? parsed.error.message : '';
      } catch (err) { /* non-JSON error body */ }

      if (res.status === 403) {
        return 'Google Drive refused the request' + (detail ? ': ' + detail : '') +
          '. Check the Drive API is enabled for your project.';
      }
      if (res.status === 404) {
        return 'That file was not found, or this Google account cannot open it.';
      }
      if (res.status === 429 || res.status === 503) {
        return 'Google Drive is rate limiting or unavailable. The next edit will retry.';
      }
      return 'Google Drive error ' + res.status + (detail ? ': ' + detail : '');
    }, function () {
      return 'Google Drive error ' + res.status + '.';
    });
  }

  window.FT = window.FT || {};
  window.FT.Drive = Drive;
  window.FT.DRIVE_SCOPE = SCOPE;
})(window);

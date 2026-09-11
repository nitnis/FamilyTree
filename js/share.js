/* ---------------------------------------------------------------
   share.js — put the whole tree in the URL.

   A share link carries the tree itself in the fragment rather than
   pointing at a file somewhere:

     https://…/FamilyTree/#tree=g<base64url of gzipped JSON>

   Nothing is hosted, nothing is fetched, and no account is involved.
   The fragment is never sent to a server — not to GitHub Pages, not to
   anyone — so the tree stays between the two browsers that hold the
   link.

   The payload's first character says how it is encoded: 'g' gzipped,
   'u' plain, so a browser without CompressionStream can still read and
   write links, just longer ones.
   --------------------------------------------------------------- */
(function (window) {
  'use strict';

  var KEY = 'tree=';
  var GZIP = 'g';
  var PLAIN = 'u';

  // Long URLs survive browsers far better than they survive the apps people
  // paste them into, which is what these thresholds are really about.
  var SAFE_LENGTH = 4000;
  var LONG_LENGTH = 16000;

  /** An error whose message is meant for the person reading it. */
  function friendly(message) {
    var err = new Error(message);
    err.friendly = true;
    return err;
  }

  function hasCompression() {
    return typeof window.CompressionStream === 'function' &&
      typeof window.DecompressionStream === 'function';
  }

  /* ------------------------------- base64 ------------------------------- */

  function toBase64Url(bytes) {
    var binary = '';
    // Chunked so a large tree cannot blow the argument limit.
    var CHUNK = 0x8000;
    for (var i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return window.btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function fromBase64Url(text) {
    var b64 = String(text).replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    var binary = window.atob(b64);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function utf8Bytes(text) {
    if (typeof window.TextEncoder === 'function') return new window.TextEncoder().encode(text);
    return fromBase64Url(toBase64Url(new Uint8Array(unescape(encodeURIComponent(text)).split('')
      .map(function (c) { return c.charCodeAt(0); }))));
  }

  function utf8Text(bytes) {
    if (typeof window.TextDecoder === 'function') return new window.TextDecoder().decode(bytes);
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return decodeURIComponent(escape(s));
  }

  /* ------------------------------- gzip -------------------------------- */

  function gzip(text) {
    var stream = new window.Blob([text]).stream()
      .pipeThrough(new window.CompressionStream('gzip'));
    return new window.Response(stream).arrayBuffer().then(function (buf) {
      return new Uint8Array(buf);
    });
  }

  function gunzip(bytes) {
    var stream = new window.Blob([bytes]).stream()
      .pipeThrough(new window.DecompressionStream('gzip'));
    return new window.Response(stream).text();
  }

  /* ------------------------------ encoding ----------------------------- */

  var Share = {
    KEY: KEY,

    /** Encode a tree into a fragment payload. */
    encode: function (state) {
      var json = JSON.stringify(state);
      if (!hasCompression()) {
        return Promise.resolve(PLAIN + toBase64Url(utf8Bytes(json)));
      }
      return gzip(json).then(function (bytes) {
        return GZIP + toBase64Url(bytes);
      }, function () {
        return PLAIN + toBase64Url(utf8Bytes(json));   // compression refused
      });
    },

    /** Decode a fragment payload back into a tree. */
    decode: function (payload) {
      return new Promise(function (resolve, reject) {
        var text = String(payload || '');
        if (!text) return reject(friendly('This share link is empty.'));

        var mode = text.charAt(0);
        var body = text.slice(1);
        if (mode !== GZIP && mode !== PLAIN) {
          return reject(friendly('This share link is not in a format this version understands.'));
        }

        var bytes;
        try {
          bytes = fromBase64Url(body);
        } catch (err) {
          return reject(friendly('This share link is damaged — it may have been cut short.'));
        }

        var pending;
        if (mode === GZIP) {
          if (!hasCompression()) {
            return reject(friendly('This browser cannot read compressed share links.'));
          }
          pending = gunzip(bytes);
        } else {
          pending = Promise.resolve(utf8Text(bytes));
        }

        pending.then(function (json) {
          var data;
          try {
            data = JSON.parse(json);
          } catch (err) {
            throw friendly('This share link is damaged — it may have been cut short.');
          }
          if (!data || !Array.isArray(data.people)) {
            throw friendly('This share link does not contain a family tree.');
          }
          resolve(data);
        }).then(null, function (err) {
          // A failed gunzip throws its own opaque message, so anything not
          // raised above is reported as damage.
          reject(err && err.friendly ? err
            : friendly('This share link is damaged — it may have been cut short.'));
        });
      });
    },

    /** Build the full shareable URL for a tree. */
    link: function (state, base) {
      var origin = base || (window.location.origin + window.location.pathname);
      return this.encode(state).then(function (payload) {
        return origin + '#' + KEY + payload;
      });
    },

    /** True when the address bar carries a share link at all, empty or not. */
    hasLink: function (hash) {
      var text = String(hash === undefined ? window.location.hash : hash);
      if (text.charAt(0) === '#') text = text.slice(1);
      return text.indexOf(KEY) === 0;
    },

    /** The payload in the current address bar, if there is one. */
    fromLocation: function (hash) {
      var text = String(hash === undefined ? window.location.hash : hash);
      if (text.charAt(0) === '#') text = text.slice(1);
      if (text.indexOf(KEY) !== 0) return '';
      return text.slice(KEY.length);
    },

    /**
     * How safely a link of this length will travel. Browsers cope with far
     * more than the apps people paste links into, so the advice is about
     * messengers and mail clients, not the address bar.
     */
    classify: function (url) {
      var n = url.length;
      if (n <= SAFE_LENGTH) {
        return { level: 'ok', chars: n, note: 'Short enough to paste anywhere.' };
      }
      if (n <= LONG_LENGTH) {
        return {
          level: 'warn', chars: n,
          note: 'Works in any browser. Mail clients sometimes wrap very long links ' +
            'across lines, which breaks them — chat apps are usually fine.'
        };
      }
      return {
        level: 'risk', chars: n,
        note: 'Very long. Browsers still handle it, but sending a .json file with ' +
          'Export is more reliable for a tree this size.'
      };
    },

    hasCompression: hasCompression
  };

  window.FT = window.FT || {};
  window.FT.Share = Share;
})(window);

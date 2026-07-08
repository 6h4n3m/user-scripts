// ==UserScript==
// @name         Viki DASH Quality Floor
// @namespace    ahmed.viki.quality.floor
// @version      1.0.1
// @updateURL    https://raw.githubusercontent.com/6h4n3m/user-scripts/refs/heads/master/viki.com.user.js
// @description  Keep Viki DASH playback at 1080p or higher when available.
// @author       Ahmed Ghanem
// @match        https://www.viki.com/*
// @match        https://*.viki.com/*
// @match        https://viki.com/*
// @run-at       document-start
// @sandbox      raw
// @inject-into  page
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  if (window.__vikiQualityFloorInstalled) return;
  window.__vikiQualityFloorInstalled = true;

  const MIN_HEIGHT = 1080;
  const LOG = '[Viki Quality Floor]';
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  const attr = (el, name) => el.getAttribute(name) || '';
  const reps = set => Array.from(set.children).filter(el => el.localName === 'Representation');

  const isMpdUrl = url =>
    /\.mpd(?:$|[?#])|\/dash\/|dash_high_drm|mpdhd/i.test(String(url || ''));

  const isMpdText = text =>
    typeof text === 'string' && /<MPD[\s>]/.test(text);

  const fetchUrl = input =>
    typeof input === 'string' ? input :
    input instanceof URL ? input.href :
    input?.url || '';

  function isVideoSet(set) {
    const contentType = attr(set, 'contentType').toLowerCase();
    const mimeType = attr(set, 'mimeType').toLowerCase();

    if (contentType === 'video' || mimeType.startsWith('video/')) return true;
    if (contentType || mimeType) return false;

    return reps(set).some(rep => {
      const repMime = attr(rep, 'mimeType').toLowerCase();
      if (repMime) return repMime.startsWith('video/');
      return rep.hasAttribute('width') && rep.hasAttribute('height');
    });
  }

  function filterMpd(text, url = '') {
    if (!isMpdText(text)) return text;

    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) return text;

    let removed = 0;

    for (const set of doc.getElementsByTagNameNS('*', 'AdaptationSet')) {
      if (!isVideoSet(set)) continue;

      const all = reps(set);
      const low = all.filter(rep => {
        const height = Number.parseInt(attr(rep, 'height'), 10);
        return height && height < MIN_HEIGHT;
      });

      if (!low.length || low.length === all.length) continue;

      low.forEach(rep => rep.remove());
      removed += low.length;
    }

    if (!removed) return text;

    console.info(LOG, `Removed ${removed} video representation(s) below ${MIN_HEIGHT}p.`, url);
    return new XMLSerializer().serializeToString(doc);
  }

  function patchedResponse(original, body) {
    const headers = new Headers(original.headers);
    headers.delete('content-length');
    headers.set('content-type', headers.get('content-type') || 'application/dash+xml;charset=utf-8');

    const replacement = new Response(body, {
      status: original.status,
      statusText: original.statusText,
      headers
    });

    return new Proxy(replacement, {
      get(target, prop) {
        if (prop === 'url') return original.url;
        if (prop === 'type') return original.type;
        if (prop === 'ok') return original.ok;
        if (prop === 'redirected') return original.redirected;

        const value = target[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
  }

  const nativeFetch = window.fetch;
  if (nativeFetch) {
    window.fetch = async function patchedFetch(input, init) {
      const response = await nativeFetch.apply(this, arguments);

      try {
        const url = response.url || fetchUrl(input);
        const type = (response.headers.get('content-type') || '').toLowerCase();

        if (!isMpdUrl(url) && !type.includes('dash') && !type.includes('xml')) {
          return response;
        }

        const text = await response.clone().text();
        const modified = filterMpd(text, url);

        return modified === text ? response : patchedResponse(response, modified);
      } catch (err) {
        console.warn(LOG, 'fetch patch failed; using original response.', err);
        return response;
      }
    };
  }

  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function patchedOpen(method, url) {
    this.__vikiQualityFloorUrl = String(url || '');
    return nativeOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function patchedSend() {
    this.addEventListener('readystatechange', () => {
      if (this.readyState !== 4) return;

      try {
        const url = this.__vikiQualityFloorUrl;
        const type = (this.getResponseHeader('content-type') || '').toLowerCase();

        if (!isMpdUrl(url) && !type.includes('dash') && !type.includes('xml')) {
          return;
        }

        let text;
        let buffer = false;

        if (!this.responseType || this.responseType === 'text') {
          text = this.responseText;
        } else if (this.responseType === 'arraybuffer' && this.response instanceof ArrayBuffer) {
          text = decoder.decode(this.response);
          buffer = true;
        } else {
          return;
        }

        const modified = filterMpd(text, url);
        if (modified === text) return;

        if (buffer) {
          const body = encoder.encode(modified).buffer;
          Object.defineProperty(this, 'response', { configurable: true, get: () => body });
        } else {
          Object.defineProperty(this, 'responseText', { configurable: true, get: () => modified });
          Object.defineProperty(this, 'response', { configurable: true, get: () => modified });
        }
      } catch (err) {
        console.warn(LOG, 'XHR patch failed; using original response.', err);
      }
    }, true);

    return nativeSend.apply(this, arguments);
  };

  window.__vikiQualityFloor = { minHeight: MIN_HEIGHT, filterMpd };

  console.info(LOG, `Installed. Minimum video height: ${MIN_HEIGHT}p.`);
})();

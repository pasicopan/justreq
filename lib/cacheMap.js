'use strict';

const url = require('url');
const fs = require('fs');
const path = require('path');
const {md5,fsExistsSync} = require('./utils');
const xecho = require('./xecho');

const cwd = process.cwd();

class CacheMap {
  constructor(options) {
    this.fastMapFile = path.resolve(cwd, '.jr/fast-map.json');
    this.slowMapFile = path.resolve(cwd, '.jr/slow-map.json');
    if (fsExistsSync(this.fastMapFile, fs.R_OK) && !options.clean) {
      this.fastMap = JSON.parse(fs.readFileSync(this.fastMapFile, 'utf-8') || '{}');
    } else {
      this.fastMap = {};
    }
    if (fsExistsSync(this.slowMapFile, fs.R_OK) && !options.clean) {
      this.slowMap = JSON.parse(fs.readFileSync(this.slowMapFile, 'utf-8') || '{}');
    } else {
      this.slowMap = {};
    }
    this._init(options.rules);
  }

  _init(rules) {
    let pJrs = /\.jrs(?:[^\/\\]*)$/;
    this.rule = rules.map((item)=>{
      if (item.url instanceof RegExp) {
        item.patt = item.url;
      } else {
        try {
          item.patt = new RegExp(item.url);
          item.isJrs = pJrs.test(item.subs);
        } catch (err) {
          xecho('Invalid rule: url = ' + item.url, 'error', true);
        }
      }
      return item;
    });
  }

  /**
   * Check cache type
   * @param  {string} method      "GET", "POST" and so on.
   * @param  {string} sUrl        Request url, without host.
   * @param  {string} reducedData Reduced request body, without header.
   */
  check(method, sUrl, reducedData) {
    let output = {}, hit = this.match(sUrl, method), key = md5(method + sUrl + reducedData), slow;
    if (hit.isJrs) {
      output.type = 1; // JRScript substitution
      output.subs = hit.subs;
    } else if (hit.subs) {
      output.type = 2; // Normal substitution
      output.subs = hit.subs;
    } else if (hit.noCache) {
      output.type = 3; // Not allow cache
    } else if (hit.keepFresh) {
      output.type = 7; // keep fresh
      output.key = key;
      output.time = +new Date();
    } else if (this.fastMap[key]) {
      output.type = 4; // in fastmap
      output.key = key;
      output.time = this.fastMap[key];
    } else if (!hit.notfound) {
      if (slow = this.touchSlowMap(hit.ignoreArgs, method, sUrl, reducedData, key)) {
        output.type = 5; // in slowmap
        output.key = slow[0];
        output.time = slow[1];
      } else {
        output.type = 6; // Need proxy, cache to slowmap & fastmap
        output.key = key;
        output.time = +new Date();
      }
    } else {
      output.type = 0; // Need proxy, cache to fastmap
      output.key = key;
      output.time = +new Date();
    }
    if (hit.host) output.host = hit.host;
    if (hit.port) output.port = hit.port;
    return output;
  }

  // Recheck cacheType it be modify by inspector
  recheck(cacheType) {
    let key = cacheType.key;
    if (this.fastMap[key]) {
      cacheType.type = 4;
      cacheType.time = this.fastMap[key];
    }
  }

  /**
   * Update map both fastmap and slowmap
   * @param  {string} key         Value of md5(method + sUrl + buf.toString())
   * @param  {[type]} markSlowmap Should update slowmap
   */
  updateMap(key, markSlowmap) {
    let time = +new Date();
    this.fastMap[key] = time;
    if (markSlowmap) {
      for (let k in this.slowMap) {
        this.slowMap[k] = this.slowMap[k].map(function(map){
          if (map[0] === key) {
            map[1] = time;
          }
          return map;
        });
      }
    }
    fs.writeFile(this.fastMapFile, JSON.stringify(this.fastMap, null, 2), function(){});
    fs.writeFile(this.slowMapFile, JSON.stringify(this.slowMap, null, 2), function(){});
  }

  /**
   * match the rule
   * @param  {string} sUrl    Request url, without host.
   * @param  {string} method  "GET", "POST" and so on.
   * @return {object}         Matched rule, default {}
   */
  match(sUrl, method) {
    let hit = {notfound: true}, mat;
    this.rule.map((item)=>{
      if (item.method && item.method.toLowerCase() !== method.toLowerCase()) {
        return;
      }
      if (mat = sUrl.match(item.patt)) {
        Object.assign(hit, {notfound: false}, item);
        if (mat.length > 1 && hit.subs) { // Support for RegExp replacement
          hit.subs = hit.subs.replace(/\$(\d)/g, function(a, m){
            return mat[m] ? mat[m] : a;
          });
        }
      }
    });
    return hit;
  }

  /**
   * Search map of slowmap. If there isn't it, create it.
   * @param  {string} ignore      Arguments can be ignored
   * @param  {string} method      "GET", "POST" and so on.
   * @param  {string} sUrl        Request url, without host.
   * @param  {object} reducedData Request body, without header.
   * @param  {string} key         Value of md5(method + sUrl + buf.toString())
   * @return {Array}              map, default 'undefined'
   */

  touchSlowMap(ignore, method, sUrl, reducedData, key) {
    let output, u = url.parse(sUrl), caches = this.slowMap[method + u.pathname] || [],
      igs = (ignore || '').split(','), search = (u.search || '').replace(/^\?/, '&'), data = reducedData.toString();
    try {
      igs.map(function(ig){
        if (ig) {
          let patt = new RegExp('&?' + ig + '=[^&]*');
          search = search.replace(patt, '');
          data = data.replace(patt, '');
        }
      });
    } catch (err) {
      xecho(err, 'error', true);
    }
    search = search ? search.replace(/^&/, '?') : '';
    caches.map(function(item){
      if (item[2] == search) {
        if (item[3] || data) {
          if (item[3] == data) {
            output = item;
          }
        } else {
          output = item;
        }
      }
    });
    if (!output) { // create map
      let cMap = [key, +new Date(), search];
      if (data) cMap.push(data, 0);
      this.slowMap[method + u.pathname] = this.slowMap[method + u.pathname] || [];
      this.slowMap[method + u.pathname].push(cMap);
    }
    return output;
  }

}

module.exports = CacheMap;

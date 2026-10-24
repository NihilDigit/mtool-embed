/* 浏览器运行时保持自包含，同时可由 Node/Bun 导入用于测试。 */
(function (root) {
  'use strict';
  var PLACEHOLDER = /(\[主人公名字\]|\[主人公\]|\[主角\]|\[我\]|（主人公）|（我）|〇〇|\*|范)/;
  var SPACE = /^([\u4e00-\u9fa5，。！？、：；“”‘’（）]+) ([\u4e00-\u9fa5，。！？、：；“”‘’（）]+)/;
  var COUNTER = /^(枚|個|回|人|本|冊|つ|円|度)([\s\S]*)$/;
  var COUNTERS = { '枚': '枚', '個': '个', '回': '次', '人': '人', '本': '本', '冊': '册', 'つ': '个', '円': '日元', '度': '次' };
  var VERB = /^(?:获得了?|取得了?|得到了?|收到了?|拿到了?|获取了?)$/;
  function decodeLiteral(text, quote) {
    var result = '';
    for (var i = 0; i < text.length; i++) {
      if (text[i] !== '\\') { result += text[i]; continue; }
      var c = text[++i];
      var escapes = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' };
      if (c === 'u' && /^[0-9a-f]{4}$/i.test(text.slice(i + 1, i + 5))) { result += String.fromCharCode(parseInt(text.slice(i + 1, i + 5), 16)); i += 4; }
      else if (c === 'x' && /^[0-9a-f]{2}$/i.test(text.slice(i + 1, i + 3))) { result += String.fromCharCode(parseInt(text.slice(i + 1, i + 3), 16)); i += 2; }
      else if (c === '\n') {} else if (c === '\r') { if (text[i + 1] === '\n') i++; }
      else result += Object.prototype.hasOwnProperty.call(escapes, c) ? escapes[c] : (c || '');
    }
    return result;
  }
  // 不执行输入代码；跳过注释、正则和带插值的模板，避免修改代码语法。
  function literals(code) {
    var found = [], i = 0, previous = '', parens = [];
    while (i < code.length) {
      var c = code[i];
      if (/\s/.test(c)) { i++; continue; }
      if (c === '/' && code[i + 1] === '/') { i = code.indexOf('\n', i + 2); if (i < 0) break; continue; }
      if (c === '/' && code[i + 1] === '*') { var end = code.indexOf('*/', i + 2); i = end < 0 ? code.length : end + 2; continue; }
      if (c === '(') { parens.push(/^(if|while|for|with|switch|catch)$/.test(previous)); previous = c; i++; continue; }
      if (c === ')') { previous = parens.pop() ? 'control)' : ')'; i++; continue; }
      if (c === '/' && (!previous || previous === 'control)' || previous === '}' || /[=(:,!&|?;{\[]/.test(previous) || /^(return|throw|case|yield|else|do)$/.test(previous))) {
        i++; var inClass = false;
        while (i < code.length) { if (code[i] === '\\') { i += 2; continue; } if (code[i] === '[') inClass = true; if (code[i] === ']') inClass = false; if (code[i++] === '/' && !inClass) break; }
        while (/[a-z]/i.test(code[i] || '') && i < code.length) i++;
        previous = 'value'; continue;
      }
      if (c === '"' || c === "'" || c === '`') {
        var start = i++, interpolated = false;
        while (i < code.length) { if (code[i] === '\\') { i += 2; continue; } if (c === '`' && code.slice(i, i + 2) === '${') interpolated = true; if (code[i++] === c) break; }
        if (code[i - 1] === c && !interpolated) found.push({ start: start, end: i, quote: c, value: decodeLiteral(code.slice(start + 1, i - 1), c) });
        previous = 'value'; continue;
      }
      if (/[a-zA-Z_$]/.test(c)) { var word = /^[\w$]+/.exec(code.slice(i))[0]; previous = word; i += word.length; }
      else { previous = c; i++; }
    }
    return found;
  }
  function compileDictionary(rawJson) {
    if (typeof rawJson === 'string') rawJson = JSON.parse(rawJson.replace(/^\uFEFF/, ''));
    if (!rawJson || typeof rawJson !== 'object' || Array.isArray(rawJson)) throw new Error('翻译词典必须是 JSON 对象');
    var exactMap = new Map(), trimmedMap = new Map(), faceIds = new Set(), transformedArrays = new WeakSet();
    function add(key, value, derived) {
      if (typeof value !== 'string' || !key) return;
      if (!derived || !exactMap.has(key)) exactMap.set(key, value);
      if (!derived || !trimmedMap.has(key.trim())) trimmedMap.set(key.trim(), value.trim());
    }
    Object.keys(rawJson).forEach(function (key) { add(key, rawJson[key], false); });
    Object.keys(rawJson).forEach(function (key) {
      var value = rawJson[key];
      if (typeof value !== 'string') return;
      if (/^[&+]/.test(key)) {
        var source = literals(key), target = literals(value);
        if (source.length === target.length) source.forEach(function (part, index) { add(part.value, target[index].value, true); });
      }
      if (key.indexOf('の倍数') === 0 && value.indexOf('的倍数') === 0) add('の倍数', '的倍数', true);
    });
    function direct(str) {
      if (exactMap.has(str)) return exactMap.get(str);
      var trimmed = str.trim();
      if (trimmed && trimmedMap.has(trimmed)) return str.slice(0, str.indexOf(trimmed)) + trimmedMap.get(trimmed) + str.slice(str.indexOf(trimmed) + trimmed.length);
      return str;
    }
    function translateDynamicPattern(str, depth) {
      depth = depth || 0;
      if (depth > 12) return str;
      var bracket = /^(.*【)([\s\S]*)(】[\s\S]*)$/.exec(str);
      if (bracket && (exactMap.has(bracket[1]) || exactMap.has(bracket[3]))) return direct(bracket[1]) + translateText(bracket[2], depth + 1) + direct(bracket[3]);
      var colon = /^(.*?)([：:])([\s\S]*)$/.exec(str);
      if (colon) return translateText(colon[1], depth + 1) + colon[2] + translateText(colon[3], depth + 1);
      var count = /^([+\-−]?\d+(?:[.,]\d+)*)([^\d\s]+)$/.exec(str);
      if (count && (exactMap.has(count[2]) || COUNTERS[count[2]])) return count[1] + (exactMap.get(count[2]) || COUNTERS[count[2]]);
      if (/^[+\-]?\d+の倍数$/.test(str)) return str.replace(/の倍数$/, exactMap.get('の倍数') || '的倍数');
      if (str.indexOf('♪') >= 0) return str.replace(/([^♪\s]+)♪/g, function (_, part) { return (part.indexOf('マイナス') === 0 ? '负' + translateText(part.slice(4), depth + 1) : translateText(part, depth + 1)) + '♪'; });
      return str;
    }
    function translateText(str, depth) {
      if (typeof str !== 'string') return str;
      var value = direct(str);
      return value !== str ? value : translateDynamicPattern(str, depth || 0);
    }
    function isSafeJsLiteral(value) {
      return typeof value === 'string' && exactMap.has(value) && !faceIds.has(value) && !/[\\/]/.test(value) && !/\.(?:png|jpe?g|webp|svg|wav|mp3|ogg|gif|ks|tjs|js|json|css|html?|mp4|webm|woff2?|ttf|otf)(?:[?#]|$)/i.test(value) && !/^[a-zA-Z_$][\w$]*(?:\.[\w$]+)*$/.test(value);
    }
    function translateJsCodeLiterals(code) {
      if (typeof code !== 'string') return code;
      var result = '', offset = 0;
      literals(code).forEach(function (part) {
        if (!isSafeJsLiteral(part.value)) return;
        var translated = exactMap.get(part.value);
        // JSON 引号不依赖原引号风格，也能正确转义换行和反斜杠。
        result += code.slice(offset, part.start) + JSON.stringify(translated).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
        offset = part.end;
      });
      return result + code.slice(offset);
    }
    function translateStateObject(obj) {
      var visited = new Set();
      function visit(value) {
        if (!value || typeof value !== 'object' || visited.has(value)) return;
        var proto = Object.getPrototypeOf(value);
        if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) return;
        visited.add(value);
        Object.keys(value).forEach(function (key) {
          var desc = Object.getOwnPropertyDescriptor(value, key);
          if (!desc || !Object.prototype.hasOwnProperty.call(desc, 'value') || !desc.writable) return;
          if (isSafeJsLiteral(desc.value)) value[key] = exactMap.get(desc.value);
          else visit(desc.value);
        });
      }
      visit(obj); return obj;
    }
    function textOf(node) { return node && node.name === 'text' && node.pm && typeof node.pm.val === 'string' ? node.pm.val : null; }
    function textNode(node, value) { return Object.assign({}, node, { pm: Object.assign({}, node.pm, { val: value }) }); }
    function splitPlaceholder(value) {
      var match = PLACEHOLDER.exec(value);
      if (match) return [value.slice(0, match.index), value.slice(match.index + match[0].length)];
      match = SPACE.exec(value);
      if (match) return [match[1], value.slice(match[1].length + 1)];
      return null;
    }
    function transformScenarioArray(input, labels) {
      var res = Array.isArray(input) ? { array_s: input, map_label: labels || {} } : input;
      if (!res || !Array.isArray(res.array_s)) return input;
      var source = res.array_s, output = [];
      if (transformedArrays.has(source)) return input;
      transformedArrays.add(source);
      for (var i = 0; i < source.length; i++) {
        var a = source[i], b = source[i + 1], c = source[i + 2], d = source[i + 3], e = source[i + 4];
        var av = textOf(a), cv = textOf(c), ev = textOf(e);
        var at = translateText(av), ct = translateText(cv), et = translateText(ev);
        // 五节点中 X 为来源、Y 为数量，B 自身包含来源助词与宾语。
        var endFive = ev && COUNTER.exec(ev);
        if (av !== null && b && b.name === 'emb' && cv && cv.indexOf('から') >= 0 && /を$/.test(cv) && d && d.name === 'emb' && endFive && /^(?:もらった|貰った|獲得した|手に入れた)/.test(endFive[2])) {
          var boundary = cv.indexOf('から'), noun = cv.slice(boundary + 2, -1), translatedNoun = translateText(noun);
          // 独立名词没有词条时，从已翻译的宾语片段移除中文语法前缀。
          if (translatedNoun === noun && ct !== cv && boundary === 0) translatedNoun = ct.replace(/^(?:从|由|向)?(?:那里|这里|处)?(?:获得了?|得到了?|收到了?|拿到了?|给(?:了|的)?|提供的|的)?/, '').replace(/[，。！!？?]+$/, '');
          var pureVerb = et.replace(/[。！!？?]+$/, '');
          if (translatedNoun && !/[\u3040-\u30ff]/.test(translatedNoun) && (translatedNoun !== noun || ct !== cv) && VERB.test(pureVerb)) {
            output.push(textNode(a, /从$/.test(at) ? at : at + '从'), b, textNode(c, translateText(cv.slice(0, boundary)) + pureVerb), d, textNode(e, (exactMap.get(endFive[1]) || COUNTERS[endFive[1]]) + translatedNoun + ((et.match(/[。！!？?]+$/) || ev.match(/[。！!？?]+$/) || [''])[0])));
            i += 4; continue;
          }
        }
        var counter = cv && COUNTER.exec(cv), verb = ct && ct.replace(/[。！!？?]+$/, '');
        if (av !== null && /を$/.test(av) && b && b.name === 'emb' && counter && /^(?:獲得しました|獲得した|手に入れた|もらった|貰った|入手した|得た)/.test(counter[2]) && at !== av && !/(?:获得|取得|得到|收到|拿到|获取)/.test(at) && VERB.test(verb)) {
          output.push(textNode(a, verb), b, textNode(c, (exactMap.get(counter[1]) || COUNTERS[counter[1]]) + at + ((ct.match(/[。！!？?]+$/) || cv.match(/[。！!？?]+$/) || [''])[0])));
          i += 2; continue;
        }
        // 相邻文本翻译含显式占位符时，将同一个 emb 节点放回占位位置。
        if (av !== null && b && b.name === 'emb') {
          var beforeSplit = at !== av && splitPlaceholder(at);
          if (beforeSplit) { output.push(textNode(a, beforeSplit[0]), b, textNode(a, beforeSplit[1])); i++; continue; }
        }
        if (a && a.name === 'emb' && textOf(b) !== null) {
          var bv = textOf(b), bt = translateText(bv), afterSplit = bt !== bv && splitPlaceholder(bt);
          if (afterSplit) { output.push(textNode(b, afterSplit[0]), a, textNode(b, afterSplit[1])); i++; continue; }
          var particle = /^(のを|を|に|への|の|へと)/.test(bv) && /^(.*?(?:让|将|把|向|对|为))的([\u4e00-\u9fa5][\s\S]*)$/.exec(bt);
          if (particle) { output.push(textNode(b, particle[1]), a, textNode(b, '的' + particle[2])); i++; continue; }
        }
        if (av !== null) output.push(textNode(a, at));
        else {
          // 仅翻译明确显示文本属性，storage、target、name 等内部字段保持原样。
          if (a && a.pm) {
            var cloned = Object.assign({}, a, { pm: Object.assign({}, a.pm) });
            ['text', 'title', 'message'].forEach(function (key) { if (typeof cloned.pm[key] === 'string' && cloned.pm[key][0] !== '&') cloned.pm[key] = translateText(cloned.pm[key]); });
            output.push(cloned);
          } else output.push(a);
        }
      }
      source.length = 0;
      for (var position = 0; position < output.length; position++) source.push(output[position]);
      if (!res.map_label) res.map_label = {};
      source.forEach(function (node, index) {
        if (!node || node.name !== 'label' || !node.pm) return;
        node.pm.index = index;
        var name = node.pm.label_name || node.pm.name;
        if (name) { var old = res.map_label[name]; res.map_label[name] = Object.assign({}, old && typeof old === 'object' ? old : node.pm, { index: index }); }
      });
      return input;
    }
    return { exactMap: exactMap, trimmedMap: trimmedMap, faceIds: faceIds, translateText: translateText, translateDynamicPattern: translateDynamicPattern, isSafeJsLiteral: isSafeJsLiteral, translateJsCodeLiterals: translateJsCodeLiterals, translateStateObject: translateStateObject, transformScenarioArray: transformScenarioArray };
  }
  function loadDictionary(host) {
    host = host || root;
    var errors = [], fs, path, processObject;
    try {
      var req = typeof host.require === 'function' ? host.require.bind(host) : null;
      fs = host.studio_api && host.studio_api.fs_default || (req && req('fs'));
      if (fs && fs.default) fs = fs.default;
      path = req && req('path');
      processObject = host.process || (req && req('process'));
      var candidates = [];
      if (processObject && processObject.execPath) candidates.push((path ? path.dirname(processObject.execPath) : processObject.execPath.replace(/[\\/][^\\/]*$/, '')) + '/翻译文件.json');
      if (processObject && typeof processObject.cwd === 'function') candidates.push(processObject.cwd() + '/翻译文件.json');
      for (var i = 0; fs && i < candidates.length; i++) {
        try { return compileDictionary(fs.readFileSync(candidates[i], 'utf8')); } catch (error) { errors.push(error.message); }
      }
    } catch (error) { errors.push(error.message); }
    try {
      var xhr = new host.XMLHttpRequest(); xhr.open('GET', './翻译文件.json', false); xhr.send(null);
      if (xhr.status !== 0 && (xhr.status < 200 || xhr.status >= 300)) throw new Error('词典 HTTP ' + xhr.status);
      return compileDictionary(xhr.responseText);
    } catch (error) { errors.push(error.message); throw new Error('无法加载翻译文件: ' + errors.join('; ')); }
  }
  function install(kag, dictionary) {
    if (!kag || kag.__mtoolEmbedInstalled) return false;
    kag.__mtoolEmbedInstalled = true;
    var api = dictionary;
    function wrap(target, name, factory) { if (target && typeof target[name] === 'function') target[name] = factory(target[name]); }
    function registerFaces(state) {
      var chars = (state || kag.stat || {}).charas;
      Object.keys(chars || {}).forEach(function (name) { var faces = chars[name] && chars[name].map_face; Object.keys(faces || {}).forEach(function (face) { api.faceIds.add(face); }); });
    }
    registerFaces();
    wrap(kag.parser, 'parseScenario', function (original) { return function () {
      var result = original.apply(this, arguments);
      api.transformScenarioArray(result);
      return result;
    }; });
    var tagSets = [kag.ftag && kag.ftag.master_tag, kag.tag];
    tagSets.forEach(function (tags, index) {
      if (!tags || tagSets.indexOf(tags) !== index) return;
      wrap(tags.chara_face, 'start', function (original) { return function (pm) { if (pm && pm.face) api.faceIds.add(pm.face); return original.apply(this, arguments); }; });
      wrap(tags.chara_new, 'start', function (original) { return function (pm) {
        var origJname = pm && typeof pm.jname === 'string' ? pm.jname : '';
        var transJname = origJname ? api.translateText(origJname) : '';
        if (pm && transJname) pm.jname = transJname;
        var ret = original.apply(this, arguments);
        var stat = (this && this.kag && this.kag.stat) || kag.stat;
        if (stat && stat.jcharas && pm && pm.name) {
          if (origJname) stat.jcharas[origJname] = pm.name;
          if (transJname) stat.jcharas[transJname] = pm.name;
        }
        return ret;
      }; });
      wrap(tags.chara_ptext, 'start', function (original) { return function (pm) {
        if (pm && typeof pm.name === 'string' && pm.name !== '') {
          var stat = (this && this.kag && this.kag.stat) || kag.stat;
          var known = stat && ((stat.jcharas && stat.jcharas[pm.name]) || (stat.charas && stat.charas[pm.name]));
          if (!known) pm.name = api.translateText(pm.name);
        }
        return original.apply(this, arguments);
      }; });
      wrap(tags.text, 'start', function (original) { return function (pm) {
        if (pm && typeof pm.val === 'string') pm.val = api.translateText(pm.val);
        return original.apply(this, arguments);
      }; });
      wrap(tags.text, 'showMessage', function (original) { return function (message) {
        var args = Array.prototype.slice.call(arguments); args[0] = api.translateText(message);
        return original.apply(this, args);
      }; });
      ['ptext', 'glink', 'dialog'].forEach(function (tname) {
        wrap(tags[tname], 'start', function (original) { return function (pm) {
          if (pm && typeof pm.text === 'string') pm.text = api.translateText(pm.text);
          return original.apply(this, arguments);
        }; });
      });
      wrap(tags.title, 'start', function (original) { return function (pm) {
        if (pm && typeof pm.name === 'string') pm.name = api.translateText(pm.name);
        return original.apply(this, arguments);
      }; });
    });
    wrap(kag.ftag, 'startTag', function (original) { return function (name, pm) {
      if (pm && typeof pm === 'object') {
        if (name === 'text' && typeof pm.val === 'string') pm.val = api.translateText(pm.val);
        else if ((name === 'ptext' || name === 'glink' || name === 'dialog') && typeof pm.text === 'string') pm.text = api.translateText(pm.text);
        else if (name === 'title' && typeof pm.name === 'string') pm.name = api.translateText(pm.name);
      }
      return original.apply(this, arguments);
    }; });
    wrap(kag, 'evalScript', function (original) { return function (code) { var args = Array.prototype.slice.call(arguments); args[0] = api.translateJsCodeLiterals(code); return original.apply(this, args); }; });
    wrap(kag.ftag, 'convertEntity', function (original) { return function (pm) {
      if (pm && typeof pm === 'object') Object.keys(pm).forEach(function (key) {
        var value = pm[key];
        if (typeof value === 'string' && value[0] === '&' && (['text', 'title', 'message', 'val'].indexOf(key) >= 0 || !/\.(?:png|jpe?g|wav|mp3|ogg|gif|ks)\b/i.test(value))) pm[key] = api.translateJsCodeLiterals(value);
      });
      var converted = original.apply(this, arguments);
      if (converted && typeof converted === 'object') ['text', 'title', 'message'].forEach(function (key) { if (typeof converted[key] === 'string') converted[key] = api.translateText(converted[key]); });
      return converted;
    }; });
    wrap(kag, 'embScript', function (original) { return function (code) {
      var args = Array.prototype.slice.call(arguments);
      if (typeof code === 'string' && !/\.(?:png|jpe?g|wav|mp3|ogg|gif|ks)\b/i.test(code)) args[0] = api.translateJsCodeLiterals(code);
      return original.apply(this, args);
    }; });
    wrap(kag, 'loadScenario', function (original) { return function () {
      var args = Array.prototype.slice.call(arguments), owner = this;
      // Tyrano 版本间 callback 位置不同，保留原签名及 this。
      for (var i = 0; i < args.length; i++) if (typeof args[i] === 'function') {
        (function (index, callback) { args[index] = function (array, map) {
          if (Array.isArray(array)) api.transformScenarioArray(array, map || (owner.stat && owner.stat.map_label));
          else if (array && Array.isArray(array.array_s)) api.transformScenarioArray(array);
          return callback.apply(this, arguments);
        }; })(i, args[i]);
      }
      return original.apply(this, args);
    }; });
    wrap(kag.menu, 'getSaveData', function (original) { return function () {
      var dataObj = original.apply(this, arguments);
      if (dataObj && Array.isArray(dataObj.data)) {
        for (var i = 0; i < dataObj.data.length; i++) {
          if (dataObj.data[i] && typeof dataObj.data[i].title === 'string') {
            dataObj.data[i].title = api.translateText(dataObj.data[i].title);
          }
        }
      }
      return dataObj;
    }; });
    wrap(kag.menu, 'loadGameData', function (original) { return function (data) {
      registerFaces(data && data.stat);
      if (data && data.stat) {
        if (data.stat.f) api.translateStateObject(data.stat.f);
        if (data.stat.charas) {
          data.stat.jcharas = data.stat.jcharas || {};
          Object.keys(data.stat.charas).forEach(function (cid) {
            var cobj = data.stat.charas[cid];
            if (cobj && typeof cobj.jname === 'string') {
              var origJ = cobj.jname, transJ = api.translateText(origJ);
              data.stat.jcharas[origJ] = cid;
              data.stat.jcharas[transJ] = cid;
              cobj.jname = transJ;
            }
          });
        }
      }
      return original.apply(this, arguments);
    }; });
    if (root && root.tyrano_lang && root.tyrano_lang.word) {
      Object.keys(root.tyrano_lang.word).forEach(function (wk) {
        if (typeof root.tyrano_lang.word[wk] === 'string') {
          root.tyrano_lang.word[wk] = api.translateText(root.tyrano_lang.word[wk]);
        }
      });
    }
    if (root && root.jQuery && root.jQuery.fn && typeof root.jQuery.fn.updatePText === 'function' && !root.jQuery.fn.updatePText.__mtoolWrapped) {
      var origUpdatePText = root.jQuery.fn.updatePText;
      root.jQuery.fn.updatePText = function (text) {
        if (typeof text === 'string') text = api.translateText(text);
        return origUpdatePText.call(this, text);
      };
      root.jQuery.fn.updatePText.__mtoolWrapped = true;
    }
    function attachEvents(targetKag) {
      if (!targetKag || typeof targetKag.on !== 'function' || targetKag.__mtoolEventsAttached) return;
      targetKag.__mtoolEventsAttached = true;
      ['glink', 'ptext', 'dialog'].forEach(function (tname) {
        targetKag.on('tag-' + tname, function (e) {
          if (e && e.target && typeof e.target.text === 'string') e.target.text = api.translateText(e.target.text);
        });
      });
      targetKag.on('tag-title', function (e) {
        if (e && e.target && typeof e.target.name === 'string') e.target.name = api.translateText(e.target.name);
      });
    }
    attachEvents(kag);
    wrap(kag, 'init', function (original) { return function () {
      var ret = original.apply(this, arguments);
      attachEvents(this);
      return ret;
    }; });
    kag.__mtoolEmbed = api;
    return true;
  }
  var exported = { compileDictionary: compileDictionary, loadDictionary: loadDictionary, install: install, literals: literals };
  if (typeof module === 'object' && module.exports) module.exports = exported;
  if (root && root.document) {
    root.MToolEmbedRuntime = exported;
    var attempts = 0;
    function start() {
      var kag = root.TYRANO && root.TYRANO.kag || root.tyrano && root.tyrano.plugin && root.tyrano.plugin.kag;
      if (!kag || !kag.ftag || !kag.menu || typeof kag.loadScenario !== 'function') { if (++attempts < 1200) root.setTimeout(start, 25); return; }
      try { install(kag, loadDictionary(root)); } catch (error) { if (root.console) root.console.error('[mtool-embed]', error); }
    }
    start();
  }
})(typeof window !== 'undefined' ? window : globalThis);

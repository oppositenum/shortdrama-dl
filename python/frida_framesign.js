// Frida agent: actively call MetaSec frameSign and dump Map as headers.
// Prefer send() over complex RPC during native sign; host may still use rpc.

function sendLog(m) {
  send({ type: 'log', m: String(m) });
}

function mapToObj(map) {
  var out = {};
  if (map == null) {
    out.__null = '1';
    return out;
  }
  try {
    out.__cls = String(map.$className || map.getClass().getName());
  } catch (e0) {
    out.__cls = 'unknown';
  }
  try {
    var Map = Java.use('java.util.Map');
    var jm = Java.cast(map, Map);
    var keys = jm.keySet().toArray();
    out.__size = String(keys.length);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var v = jm.get(k);
      out[String(k)] = v == null ? 'null' : String(v);
    }
    return out;
  } catch (e1) {
    out.__e1 = String(e1);
  }
  try {
    out.__str = String(map.toString());
  } catch (e2) {
    out.__e2 = String(e2);
  }
  return out;
}

function findAids() {
  var Utils = Java.use('com.bytedance.mobsec.metasec.ml.MSManagerUtils');
  var found = [];
  var cands = ['8662', '1128', '13', '32', '35', '1233', '259', '5625', '5685', '6340'];
  for (var i = 0; i < cands.length; i++) {
    try {
      var m = Utils.get(cands[i]);
      if (m != null) found.push(cands[i]);
    } catch (e) {}
  }
  return found;
}

function doFrameSign(aid, url, flag) {
  var Utils = Java.use('com.bytedance.mobsec.metasec.ml.MSManagerUtils');
  var mgr = Utils.get(String(aid));
  if (mgr == null) return { error: 'null_mgr', aid: String(aid) };
  var map = mgr.frameSign(String(url), flag | 0);
  var out = mapToObj(map);
  out.__aid = String(aid);
  out.__flag = String(flag | 0);
  out.__url = String(url).slice(0, 400);
  return out;
}

// rpc for host-driven calls (no hooks to avoid re-entry crashes)
rpc.exports = {
  ping: function () {
    return 'pong';
  },
  listAids: function () {
    var result = null;
    var err = null;
    Java.performNow(function () {
      try {
        result = findAids();
      } catch (e) {
        err = String(e);
      }
    });
    return err ? { error: err } : result || [];
  },
  frameSign: function (aid, url, flag) {
    var result = null;
    var err = null;
    Java.performNow(function () {
      try {
        result = doFrameSign(aid, url, flag | 0);
      } catch (e) {
        err = String(e);
      }
    });
    return err ? { error: err } : result || { error: 'empty' };
  },
  getToken: function (aid) {
    var result = null;
    var err = null;
    Java.performNow(function () {
      try {
        var Utils = Java.use('com.bytedance.mobsec.metasec.ml.MSManagerUtils');
        var mgr = Utils.get(String(aid));
        if (mgr == null) {
          result = { error: 'null_mgr' };
          return;
        }
        result = { token: String(mgr.getToken()) };
      } catch (e) {
        err = String(e);
      }
    });
    return err ? { error: err } : result || { error: 'empty' };
  },
  versionInfo: function () {
    var result = null;
    Java.performNow(function () {
      try {
        var Utils = Java.use('com.bytedance.mobsec.metasec.ml.MSManagerUtils');
        result = String(Utils.versionInfo());
      } catch (e) {
        result = 'err:' + e;
      }
    });
    return result;
  },
};

// Auto-sign a few shapes after Java is ready (results via send, more crash-resilient)
setTimeout(function () {
  Java.perform(function () {
    sendLog('java ready');
    try {
      sendLog('versionInfo ' + Java.use('com.bytedance.mobsec.metasec.ml.MSManagerUtils').versionInfo());
    } catch (e) {
      sendLog('versionInfo fail ' + e);
      return;
    }
    var aids;
    try {
      aids = findAids();
      send({ type: 'aids', aids: aids });
    } catch (e) {
      sendLog('findAids fail ' + e);
      return;
    }
    var aid = (aids && aids.length) ? aids[0] : '8662';
    // placeholder URL — host will call rpc.frameSign with real query
    var demo = '/novel/player/video_detail/v1/?aid=8662';
    try {
      var r = doFrameSign(aid, demo, 0);
      send({ type: 'frameSign_auto', result: r });
    } catch (e) {
      sendLog('auto frameSign fail ' + e);
    }
  });
}, 800);

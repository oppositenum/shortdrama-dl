// Native-only capture of TTNet Cronet request headers (Frida 17: use Module#findExportByName)
function L(m) { send({ type: 'log', m: String(m) }); }

function interesting(n) {
  n = String(n || '').toLowerCase();
  return (
    n.indexOf('x-') === 0 ||
    /gorgon|argus|ladon|khronos|helios|medusa|ss-stub|ss-req|neptune|cookie|token|sign|device|user-agent|content-type/.test(n)
  );
}

function main() {
  var mod = Process.findModuleByName('libsscronet.so');
  if (!mod) {
    L('libsscronet.so not loaded');
    return;
  }
  L('mod ' + mod.name + ' ' + mod.base);

  function exp(name) {
    try {
      return mod.findExportByName(name);
    } catch (e) {
      return null;
    }
  }

  var nameGet = exp('Cronet_HttpHeader_name_get');
  var valGet = exp('Cronet_HttpHeader_value_get');
  var headersAdd = exp('Cronet_UrlRequestParams_request_headers_add');
  L('nameGet=' + nameGet + ' valGet=' + valGet + ' headersAdd=' + headersAdd);

  if (!headersAdd) {
    L('no headers_add');
    return;
  }

  var nameGetFn = nameGet ? new NativeFunction(nameGet, 'pointer', ['pointer']) : null;
  var valGetFn = valGet ? new NativeFunction(valGet, 'pointer', ['pointer']) : null;

  Interceptor.attach(headersAdd, {
    onEnter: function (args) {
      this.header = args[1];
    },
    onLeave: function (retval) {
      try {
        if (!this.header || this.header.isNull() || !nameGetFn || !valGetFn) return;
        var np = nameGetFn(this.header);
        var vp = valGetFn(this.header);
        var n = np.isNull() ? '' : np.readUtf8String();
        var v = vp.isNull() ? '' : vp.readUtf8String();
        if (interesting(n) || interesting(v)) {
          send({ type: 'hdr', n: n, v: String(v).slice(0, 500) });
        }
      } catch (e) {
        L('parse ' + e);
      }
    },
  });
  L('hooked Cronet_UrlRequestParams_request_headers_add');

  // also value_set as backup
  var valSet = exp('Cronet_HttpHeader_value_set');
  var nameSet = exp('Cronet_HttpHeader_name_set');
  if (nameSet && valSet) {
    var last = {};
    Interceptor.attach(nameSet, {
      onEnter: function (args) {
        try {
          this.obj = args[0];
          this.name = args[1].readUtf8String();
        } catch (e) {
          this.name = null;
        }
      },
      onLeave: function () {
        if (this.name) last[this.obj] = this.name;
      },
    });
    Interceptor.attach(valSet, {
      onEnter: function (args) {
        try {
          var obj = args[0];
          var v = args[1].readUtf8String();
          var n = last[obj] || '';
          if (interesting(n) || interesting(v)) {
            send({ type: 'set', n: n, v: String(v).slice(0, 500) });
          }
        } catch (e) {}
      },
    });
    L('hooked name/value set');
  }

  var doSignSet = exp('Cronet_ClientOpaqueData_do_sign_set');
  if (doSignSet) {
    Interceptor.attach(doSignSet, {
      onEnter: function (args) {
        L('do_sign_set arg1=' + args[1]);
      },
    });
    L('hooked do_sign_set');
  }
}

setImmediate(main);

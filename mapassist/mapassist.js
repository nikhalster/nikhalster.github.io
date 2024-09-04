"use strict";
(function() {

var $goVersion = "go1.19.13";
Error.stackTraceLimit = Infinity;

var $NaN = NaN;
var $global, $module;
if (typeof window !== "undefined") { /* web page */
    $global = window;
} else if (typeof self !== "undefined") { /* web worker */
    $global = self;
} else if (typeof global !== "undefined") { /* Node.js */
    $global = global;
    $global.require = require;
} else { /* others (e.g. Nashorn) */
    $global = this;
}

if ($global === undefined || $global.Array === undefined) {
    throw new Error("no global object found");
}
if (typeof module !== "undefined") {
    $module = module;
}

if (!$global.fs && $global.require) {
    try {
        var fs = $global.require('fs');
        if (typeof fs === "object" && fs !== null && Object.keys(fs).length !== 0) {
            $global.fs = fs;
        }
    } catch (e) { /* Ignore if the module couldn't be loaded. */ }
}

if (!$global.fs) {
    var outputBuf = "";
    var decoder = new TextDecoder("utf-8");
    $global.fs = {
        constants: { O_WRONLY: -1, O_RDWR: -1, O_CREAT: -1, O_TRUNC: -1, O_APPEND: -1, O_EXCL: -1 }, // unused
        writeSync: function writeSync(fd, buf) {
            outputBuf += decoder.decode(buf);
            var nl = outputBuf.lastIndexOf("\n");
            if (nl != -1) {
                console.log(outputBuf.substr(0, nl));
                outputBuf = outputBuf.substr(nl + 1);
            }
            return buf.length;
        },
        write: function write(fd, buf, offset, length, position, callback) {
            if (offset !== 0 || length !== buf.length || position !== null) {
                callback(enosys());
                return;
            }
            var n = this.writeSync(fd, buf);
            callback(null, n);
        }
    };
}

var $linknames = {} // Collection of functions referenced by a go:linkname directive.
var $packages = {}, $idCounter = 0;
var $keys = m => { return m ? Object.keys(m) : []; };
var $flushConsole = () => { };
var $throwRuntimeError; /* set by package "runtime" */
var $throwNilPointerError = () => { $throwRuntimeError("invalid memory address or nil pointer dereference"); };
var $call = (fn, rcvr, args) => { return fn.apply(rcvr, args); };
var $makeFunc = fn => { return function(...args) { return $externalize(fn(this, new ($sliceType($jsObjectPtr))($global.Array.prototype.slice.call(args, []))), $emptyInterface); }; };
var $unused = v => { };
var $print = console.log;
// Under Node we can emulate print() more closely by avoiding a newline.
if (($global.process !== undefined) && $global.require) {
    try {
        var util = $global.require('util');
        $print = function(...args) { $global.process.stderr.write(util.format.apply(this, args)); };
    } catch (e) {
        // Failed to require util module, keep using console.log().
    }
}
var $println = console.log

var $initAllLinknames = () => {
    var names = $keys($packages);
    for (var i = 0; i < names.length; i++) {
        var f = $packages[names[i]]["$initLinknames"];
        if (typeof f == 'function') {
            f();
        }
    }
}

var $mapArray = (array, f) => {
    var newArray = new array.constructor(array.length);
    for (var i = 0; i < array.length; i++) {
        newArray[i] = f(array[i]);
    }
    return newArray;
};

// $mapIndex returns the value of the given key in m, or undefined if m is nil/undefined or not a map
var $mapIndex = (m, key) => {
    return typeof m.get === "function" ? m.get(key) : undefined;
};
// $mapDelete deletes the key and associated value from m.  If m is nil/undefined or not a map, $mapDelete is a no-op
var $mapDelete = (m, key) => {
    typeof m.delete === "function" && m.delete(key)
};
// Returns a method bound to the receiver instance, safe to invoke as a 
// standalone function. Bound function is cached for later reuse.
var $methodVal = (recv, name) => {
    var vals = recv.$methodVals || {};
    recv.$methodVals = vals; /* noop for primitives */
    var f = vals[name];
    if (f !== undefined) {
        return f;
    }
    var method = recv[name];
    f = method.bind(recv);
    vals[name] = f;
    return f;
};

var $methodExpr = (typ, name) => {
    var method = typ.prototype[name];
    if (method.$expr === undefined) {
        method.$expr = (...args) => {
            $stackDepthOffset--;
            try {
                if (typ.wrapped) {
                    args[0] = new typ(args[0]);
                }
                return Function.call.apply(method, args);
            } finally {
                $stackDepthOffset++;
            }
        };
    }
    return method.$expr;
};

var $ifaceMethodExprs = {};
var $ifaceMethodExpr = name => {
    var expr = $ifaceMethodExprs["$" + name];
    if (expr === undefined) {
        expr = $ifaceMethodExprs["$" + name] = (...args) => {
            $stackDepthOffset--;
            try {
                return Function.call.apply(args[0][name], args);
            } finally {
                $stackDepthOffset++;
            }
        };
    }
    return expr;
};

var $subslice = (slice, low, high, max) => {
    if (high === undefined) {
        high = slice.$length;
    }
    if (max === undefined) {
        max = slice.$capacity;
    }
    if (low < 0 || high < low || max < high || high > slice.$capacity || max > slice.$capacity) {
        $throwRuntimeError("slice bounds out of range");
    }
    if (slice === slice.constructor.nil) {
        return slice;
    }
    var s = new slice.constructor(slice.$array);
    s.$offset = slice.$offset + low;
    s.$length = high - low;
    s.$capacity = max - low;
    return s;
};

var $substring = (str, low, high) => {
    if (low < 0 || high < low || high > str.length) {
        $throwRuntimeError("slice bounds out of range");
    }
    return str.substring(low, high);
};

// Convert Go slice to an equivalent JS array type.
var $sliceToNativeArray = slice => {
    if (slice.$array.constructor !== Array) {
        return slice.$array.subarray(slice.$offset, slice.$offset + slice.$length);
    }
    return slice.$array.slice(slice.$offset, slice.$offset + slice.$length);
};

// Convert Go slice to a pointer to an underlying Go array.
// 
// Note that an array pointer can be represented by an "unwrapped" native array
// type, and it will be wrapped back into its Go type when necessary.
var $sliceToGoArray = (slice, arrayPtrType) => {
    var arrayType = arrayPtrType.elem;
    if (arrayType !== undefined && slice.$length < arrayType.len) {
        $throwRuntimeError("cannot convert slice with length " + slice.$length + " to pointer to array with length " + arrayType.len);
    }
    if (slice == slice.constructor.nil) {
        return arrayPtrType.nil; // Nil slice converts to nil array pointer.
    }
    if (slice.$array.constructor !== Array) {
        return slice.$array.subarray(slice.$offset, slice.$offset + arrayType.len);
    }
    if (slice.$offset == 0 && slice.$length == slice.$capacity && slice.$length == arrayType.len) {
        return slice.$array;
    }
    if (arrayType.len == 0) {
        return new arrayType([]);
    }

    // Array.slice (unlike TypedArray.subarray) returns a copy of an array range,
    // which is not sharing memory with the original one, which violates the spec
    // for slice to array conversion. This is incompatible with the Go spec, in
    // particular that the assignments to the array elements would be visible in
    // the slice. Prefer to fail explicitly instead of creating subtle bugs.
    $throwRuntimeError("gopherjs: non-numeric slice to underlying array conversion is not supported for subslices");
};

// Convert between compatible slice types (e.g. native and names).
var $convertSliceType = (slice, desiredType) => {
    if (slice == slice.constructor.nil) {
        return desiredType.nil; // Preserve nil value.
    }

    return $subslice(new desiredType(slice.$array), slice.$offset, slice.$offset + slice.$length);
}

var $decodeRune = (str, pos) => {
    var c0 = str.charCodeAt(pos);

    if (c0 < 0x80) {
        return [c0, 1];
    }

    if (c0 !== c0 || c0 < 0xC0) {
        return [0xFFFD, 1];
    }

    var c1 = str.charCodeAt(pos + 1);
    if (c1 !== c1 || c1 < 0x80 || 0xC0 <= c1) {
        return [0xFFFD, 1];
    }

    if (c0 < 0xE0) {
        var r = (c0 & 0x1F) << 6 | (c1 & 0x3F);
        if (r <= 0x7F) {
            return [0xFFFD, 1];
        }
        return [r, 2];
    }

    var c2 = str.charCodeAt(pos + 2);
    if (c2 !== c2 || c2 < 0x80 || 0xC0 <= c2) {
        return [0xFFFD, 1];
    }

    if (c0 < 0xF0) {
        var r = (c0 & 0x0F) << 12 | (c1 & 0x3F) << 6 | (c2 & 0x3F);
        if (r <= 0x7FF) {
            return [0xFFFD, 1];
        }
        if (0xD800 <= r && r <= 0xDFFF) {
            return [0xFFFD, 1];
        }
        return [r, 3];
    }

    var c3 = str.charCodeAt(pos + 3);
    if (c3 !== c3 || c3 < 0x80 || 0xC0 <= c3) {
        return [0xFFFD, 1];
    }

    if (c0 < 0xF8) {
        var r = (c0 & 0x07) << 18 | (c1 & 0x3F) << 12 | (c2 & 0x3F) << 6 | (c3 & 0x3F);
        if (r <= 0xFFFF || 0x10FFFF < r) {
            return [0xFFFD, 1];
        }
        return [r, 4];
    }

    return [0xFFFD, 1];
};

var $encodeRune = r => {
    if (r < 0 || r > 0x10FFFF || (0xD800 <= r && r <= 0xDFFF)) {
        r = 0xFFFD;
    }
    if (r <= 0x7F) {
        return String.fromCharCode(r);
    }
    if (r <= 0x7FF) {
        return String.fromCharCode(0xC0 | r >> 6, 0x80 | (r & 0x3F));
    }
    if (r <= 0xFFFF) {
        return String.fromCharCode(0xE0 | r >> 12, 0x80 | (r >> 6 & 0x3F), 0x80 | (r & 0x3F));
    }
    return String.fromCharCode(0xF0 | r >> 18, 0x80 | (r >> 12 & 0x3F), 0x80 | (r >> 6 & 0x3F), 0x80 | (r & 0x3F));
};

var $stringToBytes = str => {
    var array = new Uint8Array(str.length);
    for (var i = 0; i < str.length; i++) {
        array[i] = str.charCodeAt(i);
    }
    return array;
};

var $bytesToString = slice => {
    if (slice.$length === 0) {
        return "";
    }
    var str = "";
    for (var i = 0; i < slice.$length; i += 10000) {
        str += String.fromCharCode.apply(undefined, slice.$array.subarray(slice.$offset + i, slice.$offset + Math.min(slice.$length, i + 10000)));
    }
    return str;
};

var $stringToRunes = str => {
    var array = new Int32Array(str.length);
    var rune, j = 0;
    for (var i = 0; i < str.length; i += rune[1], j++) {
        rune = $decodeRune(str, i);
        array[j] = rune[0];
    }
    return array.subarray(0, j);
};

var $runesToString = slice => {
    if (slice.$length === 0) {
        return "";
    }
    var str = "";
    for (var i = 0; i < slice.$length; i++) {
        str += $encodeRune(slice.$array[slice.$offset + i]);
    }
    return str;
};

var $copyString = (dst, src) => {
    var n = Math.min(src.length, dst.$length);
    for (var i = 0; i < n; i++) {
        dst.$array[dst.$offset + i] = src.charCodeAt(i);
    }
    return n;
};

var $copySlice = (dst, src) => {
    var n = Math.min(src.$length, dst.$length);
    $copyArray(dst.$array, src.$array, dst.$offset, src.$offset, n, dst.constructor.elem);
    return n;
};

var $copyArray = (dst, src, dstOffset, srcOffset, n, elem) => {
    if (n === 0 || (dst === src && dstOffset === srcOffset)) {
        return;
    }

    if (src.subarray) {
        dst.set(src.subarray(srcOffset, srcOffset + n), dstOffset);
        return;
    }

    switch (elem.kind) {
        case $kindArray:
        case $kindStruct:
            if (dst === src && dstOffset > srcOffset) {
                for (var i = n - 1; i >= 0; i--) {
                    elem.copy(dst[dstOffset + i], src[srcOffset + i]);
                }
                return;
            }
            for (var i = 0; i < n; i++) {
                elem.copy(dst[dstOffset + i], src[srcOffset + i]);
            }
            return;
    }

    if (dst === src && dstOffset > srcOffset) {
        for (var i = n - 1; i >= 0; i--) {
            dst[dstOffset + i] = src[srcOffset + i];
        }
        return;
    }
    for (var i = 0; i < n; i++) {
        dst[dstOffset + i] = src[srcOffset + i];
    }
};

var $clone = (src, type) => {
    var clone = type.zero();
    type.copy(clone, src);
    return clone;
};

var $pointerOfStructConversion = (obj, type) => {
    if (obj.$proxies === undefined) {
        obj.$proxies = {};
        obj.$proxies[obj.constructor.string] = obj;
    }
    var proxy = obj.$proxies[type.string];
    if (proxy === undefined) {
        var properties = {};
        for (var i = 0; i < type.elem.fields.length; i++) {
            (fieldProp => {
                properties[fieldProp] = {
                    get() { return obj[fieldProp]; },
                    set(value) { obj[fieldProp] = value; }
                };
            })(type.elem.fields[i].prop);
        }
        proxy = Object.create(type.prototype, properties);
        proxy.$val = proxy;
        obj.$proxies[type.string] = proxy;
        proxy.$proxies = obj.$proxies;
    }
    return proxy;
};

var $append = function (slice) {
    return $internalAppend(slice, arguments, 1, arguments.length - 1);
};

var $appendSlice = (slice, toAppend) => {
    if (toAppend.constructor === String) {
        var bytes = $stringToBytes(toAppend);
        return $internalAppend(slice, bytes, 0, bytes.length);
    }
    return $internalAppend(slice, toAppend.$array, toAppend.$offset, toAppend.$length);
};

var $internalAppend = (slice, array, offset, length) => {
    if (length === 0) {
        return slice;
    }

    var newArray = slice.$array;
    var newOffset = slice.$offset;
    var newLength = slice.$length + length;
    var newCapacity = slice.$capacity;

    if (newLength > newCapacity) {
        newOffset = 0;
        newCapacity = Math.max(newLength, slice.$capacity < 1024 ? slice.$capacity * 2 : Math.floor(slice.$capacity * 5 / 4));

        if (slice.$array.constructor === Array) {
            newArray = slice.$array.slice(slice.$offset, slice.$offset + slice.$length);
            newArray.length = newCapacity;
            var zero = slice.constructor.elem.zero;
            for (var i = slice.$length; i < newCapacity; i++) {
                newArray[i] = zero();
            }
        } else {
            newArray = new slice.$array.constructor(newCapacity);
            newArray.set(slice.$array.subarray(slice.$offset, slice.$offset + slice.$length));
        }
    }

    $copyArray(newArray, array, newOffset + slice.$length, offset, length, slice.constructor.elem);

    var newSlice = new slice.constructor(newArray);
    newSlice.$offset = newOffset;
    newSlice.$length = newLength;
    newSlice.$capacity = newCapacity;
    return newSlice;
};

var $equal = (a, b, type) => {
    if (type === $jsObjectPtr) {
        return a === b;
    }
    switch (type.kind) {
        case $kindComplex64:
        case $kindComplex128:
            return a.$real === b.$real && a.$imag === b.$imag;
        case $kindInt64:
        case $kindUint64:
            return a.$high === b.$high && a.$low === b.$low;
        case $kindArray:
            if (a.length !== b.length) {
                return false;
            }
            for (var i = 0; i < a.length; i++) {
                if (!$equal(a[i], b[i], type.elem)) {
                    return false;
                }
            }
            return true;
        case $kindStruct:
            for (var i = 0; i < type.fields.length; i++) {
                var f = type.fields[i];
                if (!$equal(a[f.prop], b[f.prop], f.typ)) {
                    return false;
                }
            }
            return true;
        case $kindInterface:
            return $interfaceIsEqual(a, b);
        default:
            return a === b;
    }
};

var $interfaceIsEqual = (a, b) => {
    if (a === $ifaceNil || b === $ifaceNil) {
        return a === b;
    }
    if (a.constructor !== b.constructor) {
        return false;
    }
    if (a.constructor === $jsObjectPtr) {
        return a.object === b.object;
    }
    if (!a.constructor.comparable) {
        $throwRuntimeError("comparing uncomparable type " + a.constructor.string);
    }
    return $equal(a.$val, b.$val, a.constructor);
};

var $unsafeMethodToFunction = (typ, name, isPtr) => {
    if (isPtr) {
        return (r, ...args) => {
            var ptrType = $ptrType(typ);
            if (r.constructor != ptrType) {
                switch (typ.kind) {
                    case $kindStruct:
                        r = $pointerOfStructConversion(r, ptrType);
                        break;
                    case $kindArray:
                        r = new ptrType(r);
                        break;
                    default:
                        r = new ptrType(r.$get, r.$set, r.$target);
                }
            }
            return r[name](...args);
        };
    } else {
        return (r, ...args) => {
            var ptrType = $ptrType(typ);
            if (r.constructor != ptrType) {
                switch (typ.kind) {
                    case $kindStruct:
                        r = $clone(r, typ);
                        break;
                    case $kindSlice:
                        r = $convertSliceType(r, typ);
                        break;
                    case $kindComplex64:
                    case $kindComplex128:
                        r = new typ(r.$real, r.$imag);
                        break;
                    default:
                        r = new typ(r);
                }
            }
            return r[name](...args);
        };
    }
};

var $id = x => {
    return x;
};

var $instanceOf = (x, y) => {
    return x instanceof y;
};

var $typeOf = x => {
    return typeof (x);
};
var $min = Math.min;
var $mod = (x, y) => { return x % y; };
var $parseInt = parseInt;
var $parseFloat = f => {
    if (f !== undefined && f !== null && f.constructor === Number) {
        return f;
    }
    return parseFloat(f);
};

var $froundBuf = new Float32Array(1);
var $fround = Math.fround || (f => {
    $froundBuf[0] = f;
    return $froundBuf[0];
});

var $imul = Math.imul || ((a, b) => {
    var ah = (a >>> 16) & 0xffff;
    var al = a & 0xffff;
    var bh = (b >>> 16) & 0xffff;
    var bl = b & 0xffff;
    return ((al * bl) + (((ah * bl + al * bh) << 16) >>> 0) >> 0);
});

var $floatKey = f => {
    if (f !== f) {
        $idCounter++;
        return "NaN$" + $idCounter;
    }
    return String(f);
};

var $flatten64 = x => {
    return x.$high * 4294967296 + x.$low;
};

var $shiftLeft64 = (x, y) => {
    if (y === 0) {
        return x;
    }
    if (y < 32) {
        return new x.constructor(x.$high << y | x.$low >>> (32 - y), (x.$low << y) >>> 0);
    }
    if (y < 64) {
        return new x.constructor(x.$low << (y - 32), 0);
    }
    return new x.constructor(0, 0);
};

var $shiftRightInt64 = (x, y) => {
    if (y === 0) {
        return x;
    }
    if (y < 32) {
        return new x.constructor(x.$high >> y, (x.$low >>> y | x.$high << (32 - y)) >>> 0);
    }
    if (y < 64) {
        return new x.constructor(x.$high >> 31, (x.$high >> (y - 32)) >>> 0);
    }
    if (x.$high < 0) {
        return new x.constructor(-1, 4294967295);
    }
    return new x.constructor(0, 0);
};

var $shiftRightUint64 = (x, y) => {
    if (y === 0) {
        return x;
    }
    if (y < 32) {
        return new x.constructor(x.$high >>> y, (x.$low >>> y | x.$high << (32 - y)) >>> 0);
    }
    if (y < 64) {
        return new x.constructor(0, x.$high >>> (y - 32));
    }
    return new x.constructor(0, 0);
};

var $mul64 = (x, y) => {
    var x48 = x.$high >>> 16;
    var x32 = x.$high & 0xFFFF;
    var x16 = x.$low >>> 16;
    var x00 = x.$low & 0xFFFF;

    var y48 = y.$high >>> 16;
    var y32 = y.$high & 0xFFFF;
    var y16 = y.$low >>> 16;
    var y00 = y.$low & 0xFFFF;

    var z48 = 0, z32 = 0, z16 = 0, z00 = 0;
    z00 += x00 * y00;
    z16 += z00 >>> 16;
    z00 &= 0xFFFF;
    z16 += x16 * y00;
    z32 += z16 >>> 16;
    z16 &= 0xFFFF;
    z16 += x00 * y16;
    z32 += z16 >>> 16;
    z16 &= 0xFFFF;
    z32 += x32 * y00;
    z48 += z32 >>> 16;
    z32 &= 0xFFFF;
    z32 += x16 * y16;
    z48 += z32 >>> 16;
    z32 &= 0xFFFF;
    z32 += x00 * y32;
    z48 += z32 >>> 16;
    z32 &= 0xFFFF;
    z48 += x48 * y00 + x32 * y16 + x16 * y32 + x00 * y48;
    z48 &= 0xFFFF;

    var hi = ((z48 << 16) | z32) >>> 0;
    var lo = ((z16 << 16) | z00) >>> 0;

    var r = new x.constructor(hi, lo);
    return r;
};

var $div64 = (x, y, returnRemainder) => {
    if (y.$high === 0 && y.$low === 0) {
        $throwRuntimeError("integer divide by zero");
    }

    var s = 1;
    var rs = 1;

    var xHigh = x.$high;
    var xLow = x.$low;
    if (xHigh < 0) {
        s = -1;
        rs = -1;
        xHigh = -xHigh;
        if (xLow !== 0) {
            xHigh--;
            xLow = 4294967296 - xLow;
        }
    }

    var yHigh = y.$high;
    var yLow = y.$low;
    if (y.$high < 0) {
        s *= -1;
        yHigh = -yHigh;
        if (yLow !== 0) {
            yHigh--;
            yLow = 4294967296 - yLow;
        }
    }

    var high = 0, low = 0, n = 0;
    while (yHigh < 2147483648 && ((xHigh > yHigh) || (xHigh === yHigh && xLow > yLow))) {
        yHigh = (yHigh << 1 | yLow >>> 31) >>> 0;
        yLow = (yLow << 1) >>> 0;
        n++;
    }
    for (var i = 0; i <= n; i++) {
        high = high << 1 | low >>> 31;
        low = (low << 1) >>> 0;
        if ((xHigh > yHigh) || (xHigh === yHigh && xLow >= yLow)) {
            xHigh = xHigh - yHigh;
            xLow = xLow - yLow;
            if (xLow < 0) {
                xHigh--;
                xLow += 4294967296;
            }
            low++;
            if (low === 4294967296) {
                high++;
                low = 0;
            }
        }
        yLow = (yLow >>> 1 | yHigh << (32 - 1)) >>> 0;
        yHigh = yHigh >>> 1;
    }

    if (returnRemainder) {
        return new x.constructor(xHigh * rs, xLow * rs);
    }
    return new x.constructor(high * s, low * s);
};

var $divComplex = (n, d) => {
    var ninf = n.$real === Infinity || n.$real === -Infinity || n.$imag === Infinity || n.$imag === -Infinity;
    var dinf = d.$real === Infinity || d.$real === -Infinity || d.$imag === Infinity || d.$imag === -Infinity;
    var nnan = !ninf && (n.$real !== n.$real || n.$imag !== n.$imag);
    var dnan = !dinf && (d.$real !== d.$real || d.$imag !== d.$imag);
    if (nnan || dnan) {
        return new n.constructor(NaN, NaN);
    }
    if (ninf && !dinf) {
        return new n.constructor(Infinity, Infinity);
    }
    if (!ninf && dinf) {
        return new n.constructor(0, 0);
    }
    if (d.$real === 0 && d.$imag === 0) {
        if (n.$real === 0 && n.$imag === 0) {
            return new n.constructor(NaN, NaN);
        }
        return new n.constructor(Infinity, Infinity);
    }
    var a = Math.abs(d.$real);
    var b = Math.abs(d.$imag);
    if (a <= b) {
        var ratio = d.$real / d.$imag;
        var denom = d.$real * ratio + d.$imag;
        return new n.constructor((n.$real * ratio + n.$imag) / denom, (n.$imag * ratio - n.$real) / denom);
    }
    var ratio = d.$imag / d.$real;
    var denom = d.$imag * ratio + d.$real;
    return new n.constructor((n.$imag * ratio + n.$real) / denom, (n.$imag - n.$real * ratio) / denom);
};
var $kindBool = 1;
var $kindInt = 2;
var $kindInt8 = 3;
var $kindInt16 = 4;
var $kindInt32 = 5;
var $kindInt64 = 6;
var $kindUint = 7;
var $kindUint8 = 8;
var $kindUint16 = 9;
var $kindUint32 = 10;
var $kindUint64 = 11;
var $kindUintptr = 12;
var $kindFloat32 = 13;
var $kindFloat64 = 14;
var $kindComplex64 = 15;
var $kindComplex128 = 16;
var $kindArray = 17;
var $kindChan = 18;
var $kindFunc = 19;
var $kindInterface = 20;
var $kindMap = 21;
var $kindPtr = 22;
var $kindSlice = 23;
var $kindString = 24;
var $kindStruct = 25;
var $kindUnsafePointer = 26;

var $methodSynthesizers = [];
var $addMethodSynthesizer = f => {
    if ($methodSynthesizers === null) {
        f();
        return;
    }
    $methodSynthesizers.push(f);
};
var $synthesizeMethods = () => {
    $methodSynthesizers.forEach(f => { f(); });
    $methodSynthesizers = null;
};

var $ifaceKeyFor = x => {
    if (x === $ifaceNil) {
        return 'nil';
    }
    var c = x.constructor;
    return c.string + '$' + c.keyFor(x.$val);
};

var $identity = x => { return x; };

var $typeIDCounter = 0;

var $idKey = x => {
    if (x.$id === undefined) {
        $idCounter++;
        x.$id = $idCounter;
    }
    return String(x.$id);
};

// Creates constructor functions for array pointer types. Returns a new function
// instace each time to make sure each type is independent of the other.
var $arrayPtrCtor = () => {
    return function (array) {
        this.$get = () => { return array; };
        this.$set = function (v) { typ.copy(this, v); };
        this.$val = array;
    };
}

var $newType = (size, kind, string, named, pkg, exported, constructor) => {
    var typ;
    switch (kind) {
        case $kindBool:
        case $kindInt:
        case $kindInt8:
        case $kindInt16:
        case $kindInt32:
        case $kindUint:
        case $kindUint8:
        case $kindUint16:
        case $kindUint32:
        case $kindUintptr:
        case $kindUnsafePointer:
            typ = function (v) { this.$val = v; };
            typ.wrapped = true;
            typ.keyFor = $identity;
            break;

        case $kindString:
            typ = function (v) { this.$val = v; };
            typ.wrapped = true;
            typ.keyFor = x => { return "$" + x; };
            break;

        case $kindFloat32:
        case $kindFloat64:
            typ = function (v) { this.$val = v; };
            typ.wrapped = true;
            typ.keyFor = x => { return $floatKey(x); };
            break;

        case $kindInt64:
            typ = function (high, low) {
                this.$high = (high + Math.floor(Math.ceil(low) / 4294967296)) >> 0;
                this.$low = low >>> 0;
                this.$val = this;
            };
            typ.keyFor = x => { return x.$high + "$" + x.$low; };
            break;

        case $kindUint64:
            typ = function (high, low) {
                this.$high = (high + Math.floor(Math.ceil(low) / 4294967296)) >>> 0;
                this.$low = low >>> 0;
                this.$val = this;
            };
            typ.keyFor = x => { return x.$high + "$" + x.$low; };
            break;

        case $kindComplex64:
            typ = function (real, imag) {
                this.$real = $fround(real);
                this.$imag = $fround(imag);
                this.$val = this;
            };
            typ.keyFor = x => { return x.$real + "$" + x.$imag; };
            break;

        case $kindComplex128:
            typ = function (real, imag) {
                this.$real = real;
                this.$imag = imag;
                this.$val = this;
            };
            typ.keyFor = x => { return x.$real + "$" + x.$imag; };
            break;

        case $kindArray:
            typ = function (v) { this.$val = v; };
            typ.wrapped = true;
            typ.ptr = $newType(4, $kindPtr, "*" + string, false, "", false, $arrayPtrCtor());
            typ.init = (elem, len) => {
                typ.elem = elem;
                typ.len = len;
                typ.comparable = elem.comparable;
                typ.keyFor = x => {
                    return Array.prototype.join.call($mapArray(x, e => {
                        return String(elem.keyFor(e)).replace(/\\/g, "\\\\").replace(/\$/g, "\\$");
                    }), "$");
                };
                typ.copy = (dst, src) => {
                    $copyArray(dst, src, 0, 0, src.length, elem);
                };
                typ.ptr.init(typ);
                Object.defineProperty(typ.ptr.nil, "nilCheck", { get: $throwNilPointerError });
            };
            break;

        case $kindChan:
            typ = function (v) { this.$val = v; };
            typ.wrapped = true;
            typ.keyFor = $idKey;
            typ.init = (elem, sendOnly, recvOnly) => {
                typ.elem = elem;
                typ.sendOnly = sendOnly;
                typ.recvOnly = recvOnly;
            };
            break;

        case $kindFunc:
            typ = function (v) { this.$val = v; };
            typ.wrapped = true;
            typ.init = (params, results, variadic) => {
                typ.params = params;
                typ.results = results;
                typ.variadic = variadic;
                typ.comparable = false;
            };
            break;

        case $kindInterface:
            typ = { implementedBy: {}, missingMethodFor: {} };
            typ.keyFor = $ifaceKeyFor;
            typ.init = methods => {
                typ.methods = methods;
                methods.forEach(m => {
                    $ifaceNil[m.prop] = $throwNilPointerError;
                });
            };
            break;

        case $kindMap:
            typ = function (v) { this.$val = v; };
            typ.wrapped = true;
            typ.init = (key, elem) => {
                typ.key = key;
                typ.elem = elem;
                typ.comparable = false;
            };
            break;

        case $kindPtr:
            typ = constructor || function (getter, setter, target) {
                this.$get = getter;
                this.$set = setter;
                this.$target = target;
                this.$val = this;
            };
            typ.keyFor = $idKey;
            typ.init = elem => {
                typ.elem = elem;
                typ.wrapped = (elem.kind === $kindArray);
                typ.nil = new typ($throwNilPointerError, $throwNilPointerError);
            };
            break;

        case $kindSlice:
            typ = function (array) {
                if (array.constructor !== typ.nativeArray) {
                    array = new typ.nativeArray(array);
                }
                this.$array = array;
                this.$offset = 0;
                this.$length = array.length;
                this.$capacity = array.length;
                this.$val = this;
            };
            typ.init = elem => {
                typ.elem = elem;
                typ.comparable = false;
                typ.nativeArray = $nativeArray(elem.kind);
                typ.nil = new typ([]);
            };
            break;

        case $kindStruct:
            typ = function (v) { this.$val = v; };
            typ.wrapped = true;
            typ.ptr = $newType(4, $kindPtr, "*" + string, false, pkg, exported, constructor);
            typ.ptr.elem = typ;
            typ.ptr.prototype.$get = function () { return this; };
            typ.ptr.prototype.$set = function (v) { typ.copy(this, v); };
            typ.init = (pkgPath, fields) => {
                typ.pkgPath = pkgPath;
                typ.fields = fields;
                fields.forEach(f => {
                    if (!f.typ.comparable) {
                        typ.comparable = false;
                    }
                });
                typ.keyFor = x => {
                    var val = x.$val;
                    return $mapArray(fields, f => {
                        return String(f.typ.keyFor(val[f.prop])).replace(/\\/g, "\\\\").replace(/\$/g, "\\$");
                    }).join("$");
                };
                typ.copy = (dst, src) => {
                    for (var i = 0; i < fields.length; i++) {
                        var f = fields[i];
                        switch (f.typ.kind) {
                            case $kindArray:
                            case $kindStruct:
                                f.typ.copy(dst[f.prop], src[f.prop]);
                                continue;
                            default:
                                dst[f.prop] = src[f.prop];
                                continue;
                        }
                    }
                };
                /* nil value */
                var properties = {};
                fields.forEach(f => {
                    properties[f.prop] = { get: $throwNilPointerError, set: $throwNilPointerError };
                });
                typ.ptr.nil = Object.create(constructor.prototype, properties);
                typ.ptr.nil.$val = typ.ptr.nil;
                /* methods for embedded fields */
                $addMethodSynthesizer(() => {
                    var synthesizeMethod = (target, m, f) => {
                        if (target.prototype[m.prop] !== undefined) { return; }
                        target.prototype[m.prop] = function(...args) {
                            var v = this.$val[f.prop];
                            if (f.typ === $jsObjectPtr) {
                                v = new $jsObjectPtr(v);
                            }
                            if (v.$val === undefined) {
                                v = new f.typ(v);
                            }
                            return v[m.prop](...args);
                        };
                    };
                    fields.forEach(f => {
                        if (f.embedded) {
                            $methodSet(f.typ).forEach(m => {
                                synthesizeMethod(typ, m, f);
                                synthesizeMethod(typ.ptr, m, f);
                            });
                            $methodSet($ptrType(f.typ)).forEach(m => {
                                synthesizeMethod(typ.ptr, m, f);
                            });
                        }
                    });
                });
            };
            break;

        default:
            $panic(new $String("invalid kind: " + kind));
    }

    switch (kind) {
        case $kindBool:
        case $kindMap:
            typ.zero = () => { return false; };
            break;

        case $kindInt:
        case $kindInt8:
        case $kindInt16:
        case $kindInt32:
        case $kindUint:
        case $kindUint8:
        case $kindUint16:
        case $kindUint32:
        case $kindUintptr:
        case $kindUnsafePointer:
        case $kindFloat32:
        case $kindFloat64:
            typ.zero = () => { return 0; };
            break;

        case $kindString:
            typ.zero = () => { return ""; };
            break;

        case $kindInt64:
        case $kindUint64:
        case $kindComplex64:
        case $kindComplex128:
            var zero = new typ(0, 0);
            typ.zero = () => { return zero; };
            break;

        case $kindPtr:
        case $kindSlice:
            typ.zero = () => { return typ.nil; };
            break;

        case $kindChan:
            typ.zero = () => { return $chanNil; };
            break;

        case $kindFunc:
            typ.zero = () => { return $throwNilPointerError; };
            break;

        case $kindInterface:
            typ.zero = () => { return $ifaceNil; };
            break;

        case $kindArray:
            typ.zero = () => {
                var arrayClass = $nativeArray(typ.elem.kind);
                if (arrayClass !== Array) {
                    return new arrayClass(typ.len);
                }
                var array = new Array(typ.len);
                for (var i = 0; i < typ.len; i++) {
                    array[i] = typ.elem.zero();
                }
                return array;
            };
            break;

        case $kindStruct:
            typ.zero = () => { return new typ.ptr(); };
            break;

        default:
            $panic(new $String("invalid kind: " + kind));
    }

    typ.id = $typeIDCounter;
    $typeIDCounter++;
    typ.size = size;
    typ.kind = kind;
    typ.string = string;
    typ.named = named;
    typ.pkg = pkg;
    typ.exported = exported;
    typ.methods = [];
    typ.methodSetCache = null;
    typ.comparable = true;
    return typ;
};

var $methodSet = typ => {
    if (typ.methodSetCache !== null) {
        return typ.methodSetCache;
    }
    var base = {};

    var isPtr = (typ.kind === $kindPtr);
    if (isPtr && typ.elem.kind === $kindInterface) {
        typ.methodSetCache = [];
        return [];
    }

    var current = [{ typ: isPtr ? typ.elem : typ, indirect: isPtr }];

    var seen = {};

    while (current.length > 0) {
        var next = [];
        var mset = [];

        current.forEach(e => {
            if (seen[e.typ.string]) {
                return;
            }
            seen[e.typ.string] = true;

            if (e.typ.named) {
                mset = mset.concat(e.typ.methods);
                if (e.indirect) {
                    mset = mset.concat($ptrType(e.typ).methods);
                }
            }

            switch (e.typ.kind) {
                case $kindStruct:
                    e.typ.fields.forEach(f => {
                        if (f.embedded) {
                            var fTyp = f.typ;
                            var fIsPtr = (fTyp.kind === $kindPtr);
                            next.push({ typ: fIsPtr ? fTyp.elem : fTyp, indirect: e.indirect || fIsPtr });
                        }
                    });
                    break;

                case $kindInterface:
                    mset = mset.concat(e.typ.methods);
                    break;
            }
        });

        mset.forEach(m => {
            if (base[m.name] === undefined) {
                base[m.name] = m;
            }
        });

        current = next;
    }

    typ.methodSetCache = [];
    Object.keys(base).sort().forEach(name => {
        typ.methodSetCache.push(base[name]);
    });
    return typ.methodSetCache;
};

var $Bool = $newType(1, $kindBool, "bool", true, "", false, null);
var $Int = $newType(4, $kindInt, "int", true, "", false, null);
var $Int8 = $newType(1, $kindInt8, "int8", true, "", false, null);
var $Int16 = $newType(2, $kindInt16, "int16", true, "", false, null);
var $Int32 = $newType(4, $kindInt32, "int32", true, "", false, null);
var $Int64 = $newType(8, $kindInt64, "int64", true, "", false, null);
var $Uint = $newType(4, $kindUint, "uint", true, "", false, null);
var $Uint8 = $newType(1, $kindUint8, "uint8", true, "", false, null);
var $Uint16 = $newType(2, $kindUint16, "uint16", true, "", false, null);
var $Uint32 = $newType(4, $kindUint32, "uint32", true, "", false, null);
var $Uint64 = $newType(8, $kindUint64, "uint64", true, "", false, null);
var $Uintptr = $newType(4, $kindUintptr, "uintptr", true, "", false, null);
var $Float32 = $newType(4, $kindFloat32, "float32", true, "", false, null);
var $Float64 = $newType(8, $kindFloat64, "float64", true, "", false, null);
var $Complex64 = $newType(8, $kindComplex64, "complex64", true, "", false, null);
var $Complex128 = $newType(16, $kindComplex128, "complex128", true, "", false, null);
var $String = $newType(8, $kindString, "string", true, "", false, null);
var $UnsafePointer = $newType(4, $kindUnsafePointer, "unsafe.Pointer", true, "unsafe", false, null);

var $nativeArray = elemKind => {
    switch (elemKind) {
        case $kindInt:
            return Int32Array;
        case $kindInt8:
            return Int8Array;
        case $kindInt16:
            return Int16Array;
        case $kindInt32:
            return Int32Array;
        case $kindUint:
            return Uint32Array;
        case $kindUint8:
            return Uint8Array;
        case $kindUint16:
            return Uint16Array;
        case $kindUint32:
            return Uint32Array;
        case $kindUintptr:
            return Uint32Array;
        case $kindFloat32:
            return Float32Array;
        case $kindFloat64:
            return Float64Array;
        default:
            return Array;
    }
};
var $toNativeArray = (elemKind, array) => {
    var nativeArray = $nativeArray(elemKind);
    if (nativeArray === Array) {
        return array;
    }
    return new nativeArray(array);
};
var $arrayTypes = {};
var $arrayType = (elem, len) => {
    var typeKey = elem.id + "$" + len;
    var typ = $arrayTypes[typeKey];
    if (typ === undefined) {
        typ = $newType(elem.size * len, $kindArray, "[" + len + "]" + elem.string, false, "", false, null);
        $arrayTypes[typeKey] = typ;
        typ.init(elem, len);
    }
    return typ;
};

var $chanType = (elem, sendOnly, recvOnly) => {
    var string = (recvOnly ? "<-" : "") + "chan" + (sendOnly ? "<- " : " ");
    if (!sendOnly && !recvOnly && (elem.string[0] == "<")) {
        string += "(" + elem.string + ")";
    } else {
        string += elem.string;
    }
    var field = sendOnly ? "SendChan" : (recvOnly ? "RecvChan" : "Chan");
    var typ = elem[field];
    if (typ === undefined) {
        typ = $newType(4, $kindChan, string, false, "", false, null);
        elem[field] = typ;
        typ.init(elem, sendOnly, recvOnly);
    }
    return typ;
};
var $Chan = function (elem, capacity) {
    if (capacity < 0 || capacity > 2147483647) {
        $throwRuntimeError("makechan: size out of range");
    }
    this.$elem = elem;
    this.$capacity = capacity;
    this.$buffer = [];
    this.$sendQueue = [];
    this.$recvQueue = [];
    this.$closed = false;
};
var $chanNil = new $Chan(null, 0);
$chanNil.$sendQueue = $chanNil.$recvQueue = { length: 0, push() { }, shift() { return undefined; }, indexOf() { return -1; } };

var $funcTypes = {};
var $funcType = (params, results, variadic) => {
    var typeKey = $mapArray(params, p => { return p.id; }).join(",") + "$" + $mapArray(results, r => { return r.id; }).join(",") + "$" + variadic;
    var typ = $funcTypes[typeKey];
    if (typ === undefined) {
        var paramTypes = $mapArray(params, p => { return p.string; });
        if (variadic) {
            paramTypes[paramTypes.length - 1] = "..." + paramTypes[paramTypes.length - 1].substr(2);
        }
        var string = "func(" + paramTypes.join(", ") + ")";
        if (results.length === 1) {
            string += " " + results[0].string;
        } else if (results.length > 1) {
            string += " (" + $mapArray(results, r => { return r.string; }).join(", ") + ")";
        }
        typ = $newType(4, $kindFunc, string, false, "", false, null);
        $funcTypes[typeKey] = typ;
        typ.init(params, results, variadic);
    }
    return typ;
};

var $interfaceTypes = {};
var $interfaceType = methods => {
    var typeKey = $mapArray(methods, m => { return m.pkg + "," + m.name + "," + m.typ.id; }).join("$");
    var typ = $interfaceTypes[typeKey];
    if (typ === undefined) {
        var string = "interface {}";
        if (methods.length !== 0) {
            string = "interface { " + $mapArray(methods, m => {
                return (m.pkg !== "" ? m.pkg + "." : "") + m.name + m.typ.string.substr(4);
            }).join("; ") + " }";
        }
        typ = $newType(8, $kindInterface, string, false, "", false, null);
        $interfaceTypes[typeKey] = typ;
        typ.init(methods);
    }
    return typ;
};
var $emptyInterface = $interfaceType([]);
var $ifaceNil = {};
var $error = $newType(8, $kindInterface, "error", true, "", false, null);
$error.init([{ prop: "Error", name: "Error", pkg: "", typ: $funcType([], [$String], false) }]);

var $mapTypes = {};
var $mapType = (key, elem) => {
    var typeKey = key.id + "$" + elem.id;
    var typ = $mapTypes[typeKey];
    if (typ === undefined) {
        typ = $newType(4, $kindMap, "map[" + key.string + "]" + elem.string, false, "", false, null);
        $mapTypes[typeKey] = typ;
        typ.init(key, elem);
    }
    return typ;
};
var $makeMap = (keyForFunc, entries) => {
    var m = new Map();
    for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        m.set(keyForFunc(e.k), e);
    }
    return m;
};

var $ptrType = elem => {
    var typ = elem.ptr;
    if (typ === undefined) {
        typ = $newType(4, $kindPtr, "*" + elem.string, false, "", elem.exported, null);
        elem.ptr = typ;
        typ.init(elem);
    }
    return typ;
};

var $newDataPointer = (data, constructor) => {
    if (constructor.elem.kind === $kindStruct) {
        return data;
    }
    return new constructor(() => { return data; }, v => { data = v; });
};

var $indexPtr = (array, index, constructor) => {
    if (array.buffer) {
        // Pointers to the same underlying ArrayBuffer share cache.
        var cache = array.buffer.$ptr = array.buffer.$ptr || {};
        // Pointers of different primitive types are non-comparable and stored in different caches.
        var typeCache = cache[array.name] = cache[array.name] || {};
        var cacheIdx = array.BYTES_PER_ELEMENT * index + array.byteOffset;
        return typeCache[cacheIdx] || (typeCache[cacheIdx] = new constructor(() => { return array[index]; }, v => { array[index] = v; }));
    } else {
        array.$ptr = array.$ptr || {};
        return array.$ptr[index] || (array.$ptr[index] = new constructor(() => { return array[index]; }, v => { array[index] = v; }));
    }
};

var $sliceType = elem => {
    var typ = elem.slice;
    if (typ === undefined) {
        typ = $newType(12, $kindSlice, "[]" + elem.string, false, "", false, null);
        elem.slice = typ;
        typ.init(elem);
    }
    return typ;
};
var $makeSlice = (typ, length, capacity = length) => {
    if (length < 0 || length > 2147483647) {
        $throwRuntimeError("makeslice: len out of range");
    }
    if (capacity < 0 || capacity < length || capacity > 2147483647) {
        $throwRuntimeError("makeslice: cap out of range");
    }
    var array = new typ.nativeArray(capacity);
    if (typ.nativeArray === Array) {
        for (var i = 0; i < capacity; i++) {
            array[i] = typ.elem.zero();
        }
    }
    var slice = new typ(array);
    slice.$length = length;
    return slice;
};

var $structTypes = {};
var $structType = (pkgPath, fields) => {
    var typeKey = $mapArray(fields, f => { return f.name + "," + f.typ.id + "," + f.tag; }).join("$");
    var typ = $structTypes[typeKey];
    if (typ === undefined) {
        var string = "struct { " + $mapArray(fields, f => {
            var str = f.typ.string + (f.tag !== "" ? (" \"" + f.tag.replace(/\\/g, "\\\\").replace(/"/g, "\\\"") + "\"") : "");
            if (f.embedded) {
                return str;
            }
            return f.name + " " + str;
        }).join("; ") + " }";
        if (fields.length === 0) {
            string = "struct {}";
        }
        typ = $newType(0, $kindStruct, string, false, "", false, function(...args) {
            this.$val = this;
            for (var i = 0; i < fields.length; i++) {
                var f = fields[i];
                if (f.name == '_') {
                    continue;
                }
                var arg = args[i];
                this[f.prop] = arg !== undefined ? arg : f.typ.zero();
            }
        });
        $structTypes[typeKey] = typ;
        typ.init(pkgPath, fields);
    }
    return typ;
};

var $assertType = (value, type, returnTuple) => {
    var isInterface = (type.kind === $kindInterface), ok, missingMethod = "";
    if (value === $ifaceNil) {
        ok = false;
    } else if (!isInterface) {
        ok = value.constructor === type;
    } else {
        var valueTypeString = value.constructor.string;
        ok = type.implementedBy[valueTypeString];
        if (ok === undefined) {
            ok = true;
            var valueMethodSet = $methodSet(value.constructor);
            var interfaceMethods = type.methods;
            for (var i = 0; i < interfaceMethods.length; i++) {
                var tm = interfaceMethods[i];
                var found = false;
                for (var j = 0; j < valueMethodSet.length; j++) {
                    var vm = valueMethodSet[j];
                    if (vm.name === tm.name && vm.pkg === tm.pkg && vm.typ === tm.typ) {
                        found = true;
                        break;
                    }
                }
                if (!found) {
                    ok = false;
                    type.missingMethodFor[valueTypeString] = tm.name;
                    break;
                }
            }
            type.implementedBy[valueTypeString] = ok;
        }
        if (!ok) {
            missingMethod = type.missingMethodFor[valueTypeString];
        }
    }

    if (!ok) {
        if (returnTuple) {
            return [type.zero(), false];
        }
        $panic(new $packages["runtime"].TypeAssertionError.ptr(
            $packages["runtime"]._type.ptr.nil,
            (value === $ifaceNil ? $packages["runtime"]._type.ptr.nil : new $packages["runtime"]._type.ptr(value.constructor.string)),
            new $packages["runtime"]._type.ptr(type.string),
            missingMethod));
    }

    if (!isInterface) {
        value = value.$val;
    }
    if (type === $jsObjectPtr) {
        value = value.object;
    }
    return returnTuple ? [value, true] : value;
};
var $stackDepthOffset = 0;
var $getStackDepth = () => {
    var err = new Error();
    if (err.stack === undefined) {
        return undefined;
    }
    return $stackDepthOffset + err.stack.split("\n").length;
};

var $panicStackDepth = null, $panicValue;
var $callDeferred = (deferred, jsErr, fromPanic) => {
    if (!fromPanic && deferred !== null && $curGoroutine.deferStack.indexOf(deferred) == -1) {
        throw jsErr;
    }
    if (jsErr !== null) {
        var newErr = null;
        try {
            $panic(new $jsErrorPtr(jsErr));
        } catch (err) {
            newErr = err;
        }
        $callDeferred(deferred, newErr);
        return;
    }
    if ($curGoroutine.asleep) {
        return;
    }

    $stackDepthOffset--;
    var outerPanicStackDepth = $panicStackDepth;
    var outerPanicValue = $panicValue;

    var localPanicValue = $curGoroutine.panicStack.pop();
    if (localPanicValue !== undefined) {
        $panicStackDepth = $getStackDepth();
        $panicValue = localPanicValue;
    }

    try {
        while (true) {
            if (deferred === null) {
                deferred = $curGoroutine.deferStack[$curGoroutine.deferStack.length - 1];
                if (deferred === undefined) {
                    /* The panic reached the top of the stack. Clear it and throw it as a JavaScript error. */
                    $panicStackDepth = null;
                    if (localPanicValue.Object instanceof Error) {
                        throw localPanicValue.Object;
                    }
                    var msg;
                    if (localPanicValue.constructor === $String) {
                        msg = localPanicValue.$val;
                    } else if (localPanicValue.Error !== undefined) {
                        msg = localPanicValue.Error();
                    } else if (localPanicValue.String !== undefined) {
                        msg = localPanicValue.String();
                    } else {
                        msg = localPanicValue;
                    }
                    throw new Error(msg);
                }
            }
            var call = deferred.pop();
            if (call === undefined) {
                $curGoroutine.deferStack.pop();
                if (localPanicValue !== undefined) {
                    deferred = null;
                    continue;
                }
                return;
            }
            var r = call[0].apply(call[2], call[1]);
            if (r && r.$blk !== undefined) {
                deferred.push([r.$blk, [], r]);
                if (fromPanic) {
                    throw null;
                }
                return;
            }

            if (localPanicValue !== undefined && $panicStackDepth === null) {
                /* error was recovered */
                if (fromPanic) {
                    throw null;
                }
                return;
            }
        }
    } catch (e) {
        // Deferred function threw a JavaScript exception or tries to unwind stack
        // to the point where a panic was handled.
        if (fromPanic) {
            // Re-throw the exception to reach deferral execution call at the end
            // of the function.
            throw e;
        }
        // We are at the end of the function, handle the error or re-throw to
        // continue unwinding if necessary, or simply stop unwinding if we got far
        // enough.
        $callDeferred(deferred, e, fromPanic);
    } finally {
        if (localPanicValue !== undefined) {
            if ($panicStackDepth !== null) {
                $curGoroutine.panicStack.push(localPanicValue);
            }
            $panicStackDepth = outerPanicStackDepth;
            $panicValue = outerPanicValue;
        }
        $stackDepthOffset++;
    }
};

var $panic = value => {
    $curGoroutine.panicStack.push(value);
    $callDeferred(null, null, true);
};
var $recover = () => {
    if ($panicStackDepth === null || ($panicStackDepth !== undefined && $panicStackDepth !== $getStackDepth() - 2)) {
        return $ifaceNil;
    }
    $panicStackDepth = null;
    return $panicValue;
};
var $throw = err => { throw err; };

var $noGoroutine = { asleep: false, exit: false, deferStack: [], panicStack: [] };
var $curGoroutine = $noGoroutine, $totalGoroutines = 0, $awakeGoroutines = 0, $checkForDeadlock = true, $exportedFunctions = 0;
var $mainFinished = false;
var $go = (fun, args) => {
    $totalGoroutines++;
    $awakeGoroutines++;
    var $goroutine = () => {
        try {
            $curGoroutine = $goroutine;
            var r = fun(...args);
            if (r && r.$blk !== undefined) {
                fun = () => { return r.$blk(); };
                args = [];
                return;
            }
            $goroutine.exit = true;
        } catch (err) {
            if (!$goroutine.exit) {
                throw err;
            }
        } finally {
            $curGoroutine = $noGoroutine;
            if ($goroutine.exit) { /* also set by runtime.Goexit() */
                $totalGoroutines--;
                $goroutine.asleep = true;
            }
            if ($goroutine.asleep) {
                $awakeGoroutines--;
                if (!$mainFinished && $awakeGoroutines === 0 && $checkForDeadlock && $exportedFunctions === 0) {
                    console.error("fatal error: all goroutines are asleep - deadlock!");
                    if ($global.process !== undefined) {
                        $global.process.exit(2);
                    }
                }
            }
        }
    };
    $goroutine.asleep = false;
    $goroutine.exit = false;
    $goroutine.deferStack = [];
    $goroutine.panicStack = [];
    $schedule($goroutine);
};

var $scheduled = [];
var $runScheduled = () => {
    // For nested setTimeout calls browsers enforce 4ms minimum delay. We minimize
    // the effect of this penalty by queueing the timer preemptively before we run
    // the goroutines, and later cancelling it if it turns out unneeded. See:
    // https://developer.mozilla.org/en-US/docs/Web/API/setTimeout#nested_timeouts
    var nextRun = setTimeout($runScheduled);
    try {
        var start = Date.now();
        var r;
        while ((r = $scheduled.shift()) !== undefined) {
            r();
            // We need to interrupt this loop in order to allow the event loop to
            // process timers, IO, etc. However, invoking scheduling through
            // setTimeout is ~1000 times more expensive, so we amortize this cost by
            // looping until the 4ms minimal delay has elapsed (assuming there are
            // scheduled goroutines to run), and then yield to the event loop.
            var elapsed = Date.now() - start;
            if (elapsed > 4 || elapsed < 0) { break; }
        }
    } finally {
        if ($scheduled.length == 0) {
            // Cancel scheduling pass if there's nothing to run.
            clearTimeout(nextRun);
        }
    }
};

var $schedule = goroutine => {
    if (goroutine.asleep) {
        goroutine.asleep = false;
        $awakeGoroutines++;
    }
    $scheduled.push(goroutine);
    if ($curGoroutine === $noGoroutine) {
        $runScheduled();
    }
};

var $setTimeout = (f, t) => {
    $awakeGoroutines++;
    return setTimeout(() => {
        $awakeGoroutines--;
        f();
    }, t);
};

var $block = () => {
    if ($curGoroutine === $noGoroutine) {
        $throwRuntimeError("cannot block in JavaScript callback, fix by wrapping code in goroutine");
    }
    $curGoroutine.asleep = true;
};

var $restore = (context, params) => {
    if (context !== undefined && context.$blk !== undefined) {
        return context;
    }
    return params;
}

var $send = (chan, value) => {
    if (chan.$closed) {
        $throwRuntimeError("send on closed channel");
    }
    var queuedRecv = chan.$recvQueue.shift();
    if (queuedRecv !== undefined) {
        queuedRecv([value, true]);
        return;
    }
    if (chan.$buffer.length < chan.$capacity) {
        chan.$buffer.push(value);
        return;
    }

    var thisGoroutine = $curGoroutine;
    var closedDuringSend;
    chan.$sendQueue.push(closed => {
        closedDuringSend = closed;
        $schedule(thisGoroutine);
        return value;
    });
    $block();
    return {
        $blk() {
            if (closedDuringSend) {
                $throwRuntimeError("send on closed channel");
            }
        }
    };
};
var $recv = chan => {
    var queuedSend = chan.$sendQueue.shift();
    if (queuedSend !== undefined) {
        chan.$buffer.push(queuedSend(false));
    }
    var bufferedValue = chan.$buffer.shift();
    if (bufferedValue !== undefined) {
        return [bufferedValue, true];
    }
    if (chan.$closed) {
        return [chan.$elem.zero(), false];
    }

    var thisGoroutine = $curGoroutine;
    var f = { $blk() { return this.value; } };
    var queueEntry = v => {
        f.value = v;
        $schedule(thisGoroutine);
    };
    chan.$recvQueue.push(queueEntry);
    $block();
    return f;
};
var $close = chan => {
    if (chan.$closed) {
        $throwRuntimeError("close of closed channel");
    }
    chan.$closed = true;
    while (true) {
        var queuedSend = chan.$sendQueue.shift();
        if (queuedSend === undefined) {
            break;
        }
        queuedSend(true); /* will panic */
    }
    while (true) {
        var queuedRecv = chan.$recvQueue.shift();
        if (queuedRecv === undefined) {
            break;
        }
        queuedRecv([chan.$elem.zero(), false]);
    }
};
var $select = comms => {
    var ready = [];
    var selection = -1;
    for (var i = 0; i < comms.length; i++) {
        var comm = comms[i];
        var chan = comm[0];
        switch (comm.length) {
            case 0: /* default */
                selection = i;
                break;
            case 1: /* recv */
                if (chan.$sendQueue.length !== 0 || chan.$buffer.length !== 0 || chan.$closed) {
                    ready.push(i);
                }
                break;
            case 2: /* send */
                if (chan.$closed) {
                    $throwRuntimeError("send on closed channel");
                }
                if (chan.$recvQueue.length !== 0 || chan.$buffer.length < chan.$capacity) {
                    ready.push(i);
                }
                break;
        }
    }

    if (ready.length !== 0) {
        selection = ready[Math.floor(Math.random() * ready.length)];
    }
    if (selection !== -1) {
        var comm = comms[selection];
        switch (comm.length) {
            case 0: /* default */
                return [selection];
            case 1: /* recv */
                return [selection, $recv(comm[0])];
            case 2: /* send */
                $send(comm[0], comm[1]);
                return [selection];
        }
    }

    var entries = [];
    var thisGoroutine = $curGoroutine;
    var f = { $blk() { return this.selection; } };
    var removeFromQueues = () => {
        for (var i = 0; i < entries.length; i++) {
            var entry = entries[i];
            var queue = entry[0];
            var index = queue.indexOf(entry[1]);
            if (index !== -1) {
                queue.splice(index, 1);
            }
        }
    };
    for (var i = 0; i < comms.length; i++) {
        (i => {
            var comm = comms[i];
            switch (comm.length) {
                case 1: /* recv */
                    var queueEntry = value => {
                        f.selection = [i, value];
                        removeFromQueues();
                        $schedule(thisGoroutine);
                    };
                    entries.push([comm[0].$recvQueue, queueEntry]);
                    comm[0].$recvQueue.push(queueEntry);
                    break;
                case 2: /* send */
                    var queueEntry = () => {
                        if (comm[0].$closed) {
                            $throwRuntimeError("send on closed channel");
                        }
                        f.selection = [i];
                        removeFromQueues();
                        $schedule(thisGoroutine);
                        return comm[1];
                    };
                    entries.push([comm[0].$sendQueue, queueEntry]);
                    comm[0].$sendQueue.push(queueEntry);
                    break;
            }
        })(i);
    }
    $block();
    return f;
};
var $jsObjectPtr, $jsErrorPtr;

var $needsExternalization = t => {
    switch (t.kind) {
        case $kindBool:
        case $kindInt:
        case $kindInt8:
        case $kindInt16:
        case $kindInt32:
        case $kindUint:
        case $kindUint8:
        case $kindUint16:
        case $kindUint32:
        case $kindUintptr:
        case $kindFloat32:
        case $kindFloat64:
            return false;
        default:
            return t !== $jsObjectPtr;
    }
};

var $externalize = (v, t, makeWrapper) => {
    if (t === $jsObjectPtr) {
        return v;
    }
    switch (t.kind) {
        case $kindBool:
        case $kindInt:
        case $kindInt8:
        case $kindInt16:
        case $kindInt32:
        case $kindUint:
        case $kindUint8:
        case $kindUint16:
        case $kindUint32:
        case $kindUintptr:
        case $kindFloat32:
        case $kindFloat64:
            return v;
        case $kindInt64:
        case $kindUint64:
            return $flatten64(v);
        case $kindArray:
            if ($needsExternalization(t.elem)) {
                return $mapArray(v, e => { return $externalize(e, t.elem, makeWrapper); });
            }
            return v;
        case $kindFunc:
            return $externalizeFunction(v, t, false, makeWrapper);
        case $kindInterface:
            if (v === $ifaceNil) {
                return null;
            }
            if (v.constructor === $jsObjectPtr) {
                return v.$val.object;
            }
            return $externalize(v.$val, v.constructor, makeWrapper);
        case $kindMap:
            if (v.keys === undefined) {
                return null;
            }
            var m = {};
            var keys = Array.from(v.keys());
            for (var i = 0; i < keys.length; i++) {
                var entry = v.get(keys[i]);
                m[$externalize(entry.k, t.key, makeWrapper)] = $externalize(entry.v, t.elem, makeWrapper);
            }
            return m;
        case $kindPtr:
            if (v === t.nil) {
                return null;
            }
            return $externalize(v.$get(), t.elem, makeWrapper);
        case $kindSlice:
            if (v === v.constructor.nil) {
                return null;
            }
            if ($needsExternalization(t.elem)) {
                return $mapArray($sliceToNativeArray(v), e => { return $externalize(e, t.elem, makeWrapper); });
            }
            return $sliceToNativeArray(v);
        case $kindString:
            if ($isASCII(v)) {
                return v;
            }
            var s = "", r;
            for (var i = 0; i < v.length; i += r[1]) {
                r = $decodeRune(v, i);
                var c = r[0];
                if (c > 0xFFFF) {
                    var h = Math.floor((c - 0x10000) / 0x400) + 0xD800;
                    var l = (c - 0x10000) % 0x400 + 0xDC00;
                    s += String.fromCharCode(h, l);
                    continue;
                }
                s += String.fromCharCode(c);
            }
            return s;
        case $kindStruct:
            var timePkg = $packages["time"];
            if (timePkg !== undefined && v.constructor === timePkg.Time.ptr) {
                var milli = $div64(v.UnixNano(), new $Int64(0, 1000000));
                return new Date($flatten64(milli));
            }

            var noJsObject = {};
            var searchJsObject = (v, t) => {
                if (t === $jsObjectPtr) {
                    return v;
                }
                switch (t.kind) {
                    case $kindPtr:
                        if (v === t.nil) {
                            return noJsObject;
                        }
                        return searchJsObject(v.$get(), t.elem);
                    case $kindStruct:
                        if (t.fields.length === 0) {
                            return noJsObject;
                        }
                        var f = t.fields[0];
                        return searchJsObject(v[f.prop], f.typ);
                    case $kindInterface:
                        return searchJsObject(v.$val, v.constructor);
                    default:
                        return noJsObject;
                }
            };
            var o = searchJsObject(v, t);
            if (o !== noJsObject) {
                return o;
            }

            if (makeWrapper !== undefined) {
                return makeWrapper(v);
            }

            o = {};
            for (var i = 0; i < t.fields.length; i++) {
                var f = t.fields[i];
                if (!f.exported) {
                    continue;
                }
                o[f.name] = $externalize(v[f.prop], f.typ, makeWrapper);
            }
            return o;
    }
    $throwRuntimeError("cannot externalize " + t.string);
};

var $externalizeFunction = (v, t, passThis, makeWrapper) => {
    if (v === $throwNilPointerError) {
        return null;
    }
    if (v.$externalizeWrapper === undefined) {
        $checkForDeadlock = false;
        v.$externalizeWrapper = function () {
            var args = [];
            for (var i = 0; i < t.params.length; i++) {
                if (t.variadic && i === t.params.length - 1) {
                    var vt = t.params[i].elem, varargs = [];
                    for (var j = i; j < arguments.length; j++) {
                        varargs.push($internalize(arguments[j], vt, makeWrapper));
                    }
                    args.push(new (t.params[i])(varargs));
                    break;
                }
                args.push($internalize(arguments[i], t.params[i], makeWrapper));
            }
            var result = v.apply(passThis ? this : undefined, args);
            switch (t.results.length) {
                case 0:
                    return;
                case 1:
                    return $externalize($copyIfRequired(result, t.results[0]), t.results[0], makeWrapper);
                default:
                    for (var i = 0; i < t.results.length; i++) {
                        result[i] = $externalize($copyIfRequired(result[i], t.results[i]), t.results[i], makeWrapper);
                    }
                    return result;
            }
        };
    }
    return v.$externalizeWrapper;
};

var $internalize = (v, t, recv, seen, makeWrapper) => {
    if (t === $jsObjectPtr) {
        return v;
    }
    if (t === $jsObjectPtr.elem) {
        $throwRuntimeError("cannot internalize js.Object, use *js.Object instead");
    }
    if (v && v.__internal_object__ !== undefined) {
        return $assertType(v.__internal_object__, t, false);
    }
    var timePkg = $packages["time"];
    if (timePkg !== undefined && t === timePkg.Time) {
        if (!(v !== null && v !== undefined && v.constructor === Date)) {
            $throwRuntimeError("cannot internalize time.Time from " + typeof v + ", must be Date");
        }
        return timePkg.Unix(new $Int64(0, 0), new $Int64(0, v.getTime() * 1000000));
    }

    // Cache for values we've already internalized in order to deal with circular
    // references.
    if (seen === undefined) { seen = new Map(); }
    if (!seen.has(t)) { seen.set(t, new Map()); }
    if (seen.get(t).has(v)) { return seen.get(t).get(v); }

    switch (t.kind) {
        case $kindBool:
            return !!v;
        case $kindInt:
            return parseInt(v);
        case $kindInt8:
            return parseInt(v) << 24 >> 24;
        case $kindInt16:
            return parseInt(v) << 16 >> 16;
        case $kindInt32:
            return parseInt(v) >> 0;
        case $kindUint:
            return parseInt(v);
        case $kindUint8:
            return parseInt(v) << 24 >>> 24;
        case $kindUint16:
            return parseInt(v) << 16 >>> 16;
        case $kindUint32:
        case $kindUintptr:
            return parseInt(v) >>> 0;
        case $kindInt64:
        case $kindUint64:
            return new t(0, v);
        case $kindFloat32:
        case $kindFloat64:
            return parseFloat(v);
        case $kindArray:
            if (v.length !== t.len) {
                $throwRuntimeError("got array with wrong size from JavaScript native");
            }
            return $mapArray(v, e => { return $internalize(e, t.elem, makeWrapper); });
        case $kindFunc:
            return function () {
                var args = [];
                for (var i = 0; i < t.params.length; i++) {
                    if (t.variadic && i === t.params.length - 1) {
                        var vt = t.params[i].elem, varargs = arguments[i];
                        for (var j = 0; j < varargs.$length; j++) {
                            args.push($externalize(varargs.$array[varargs.$offset + j], vt, makeWrapper));
                        }
                        break;
                    }
                    args.push($externalize(arguments[i], t.params[i], makeWrapper));
                }
                var result = v.apply(recv, args);
                switch (t.results.length) {
                    case 0:
                        return;
                    case 1:
                        return $internalize(result, t.results[0], makeWrapper);
                    default:
                        for (var i = 0; i < t.results.length; i++) {
                            result[i] = $internalize(result[i], t.results[i], makeWrapper);
                        }
                        return result;
                }
            };
        case $kindInterface:
            if (t.methods.length !== 0) {
                $throwRuntimeError("cannot internalize " + t.string);
            }
            if (v === null) {
                return $ifaceNil;
            }
            if (v === undefined) {
                return new $jsObjectPtr(undefined);
            }
            switch (v.constructor) {
                case Int8Array:
                    return new ($sliceType($Int8))(v);
                case Int16Array:
                    return new ($sliceType($Int16))(v);
                case Int32Array:
                    return new ($sliceType($Int))(v);
                case Uint8Array:
                    return new ($sliceType($Uint8))(v);
                case Uint16Array:
                    return new ($sliceType($Uint16))(v);
                case Uint32Array:
                    return new ($sliceType($Uint))(v);
                case Float32Array:
                    return new ($sliceType($Float32))(v);
                case Float64Array:
                    return new ($sliceType($Float64))(v);
                case Array:
                    return $internalize(v, $sliceType($emptyInterface), makeWrapper);
                case Boolean:
                    return new $Bool(!!v);
                case Date:
                    if (timePkg === undefined) {
                        /* time package is not present, internalize as &js.Object{Date} so it can be externalized into original Date. */
                        return new $jsObjectPtr(v);
                    }
                    return new timePkg.Time($internalize(v, timePkg.Time, makeWrapper));
                case ((() => { })).constructor: // is usually Function, but in Chrome extensions it is something else
                    var funcType = $funcType([$sliceType($emptyInterface)], [$jsObjectPtr], true);
                    return new funcType($internalize(v, funcType, makeWrapper));
                case Number:
                    return new $Float64(parseFloat(v));
                case String:
                    return new $String($internalize(v, $String, makeWrapper));
                default:
                    if ($global.Node && v instanceof $global.Node) {
                        return new $jsObjectPtr(v);
                    }
                    var mapType = $mapType($String, $emptyInterface);
                    return new mapType($internalize(v, mapType, recv, seen, makeWrapper));
            }
        case $kindMap:
            var m = new Map();
            seen.get(t).set(v, m);
            var keys = $keys(v);
            for (var i = 0; i < keys.length; i++) {
                var k = $internalize(keys[i], t.key, recv, seen, makeWrapper);
                m.set(t.key.keyFor(k), { k, v: $internalize(v[keys[i]], t.elem, recv, seen, makeWrapper) });
            }
            return m;
        case $kindPtr:
            if (t.elem.kind === $kindStruct) {
                return $internalize(v, t.elem, makeWrapper);
            }
        case $kindSlice:
            return new t($mapArray(v, e => { return $internalize(e, t.elem, makeWrapper); }));
        case $kindString:
            v = String(v);
            if ($isASCII(v)) {
                return v;
            }
            var s = "";
            var i = 0;
            while (i < v.length) {
                var h = v.charCodeAt(i);
                if (0xD800 <= h && h <= 0xDBFF) {
                    var l = v.charCodeAt(i + 1);
                    var c = (h - 0xD800) * 0x400 + l - 0xDC00 + 0x10000;
                    s += $encodeRune(c);
                    i += 2;
                    continue;
                }
                s += $encodeRune(h);
                i++;
            }
            return s;
        case $kindStruct:
            var noJsObject = {};
            var searchJsObject = t => {
                if (t === $jsObjectPtr) {
                    return v;
                }
                if (t === $jsObjectPtr.elem) {
                    $throwRuntimeError("cannot internalize js.Object, use *js.Object instead");
                }
                switch (t.kind) {
                    case $kindPtr:
                        return searchJsObject(t.elem);
                    case $kindStruct:
                        if (t.fields.length === 0) {
                            return noJsObject;
                        }
                        var f = t.fields[0];
                        var o = searchJsObject(f.typ);
                        if (o !== noJsObject) {
                            var n = new t.ptr();
                            n[f.prop] = o;
                            return n;
                        }
                        return noJsObject;
                    default:
                        return noJsObject;
                }
            };
            var o = searchJsObject(t);
            if (o !== noJsObject) {
                return o;
            }
            var n = new t.ptr();
            for (var i = 0; i < t.fields.length; i++) {
              var f = t.fields[i];
      
              if (!f.exported) {
                continue;
              }
              var jsProp = v[f.name];
      
              n[f.prop] = $internalize(jsProp, f.typ, recv, seen, makeWrapper);
            }
      
            return n;
    }
    $throwRuntimeError("cannot internalize " + t.string);
};

var $copyIfRequired = (v, typ) => {
    // interface values
    if (v && v.constructor && v.constructor.copy) {
        return new v.constructor($clone(v.$val, v.constructor))
    }
    // array and struct values
    if (typ.copy) {
        var clone = typ.zero();
        typ.copy(clone, v);
        return clone;
    }
    return v;
}

/* $isASCII reports whether string s contains only ASCII characters. */
var $isASCII = s => {
    for (var i = 0; i < s.length; i++) {
        if (s.charCodeAt(i) >= 128) {
            return false;
        }
    }
    return true;
};

$packages["github.com/gopherjs/gopherjs/js"] = (function() {
	var $pkg = {}, $init, Object, Error, sliceType, ptrType, ptrType$1, MakeFunc, init;
	Object = $pkg.Object = $newType(0, $kindStruct, "js.Object", true, "github.com/gopherjs/gopherjs/js", true, function(object_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.object = null;
			return;
		}
		this.object = object_;
	});
	Error = $pkg.Error = $newType(0, $kindStruct, "js.Error", true, "github.com/gopherjs/gopherjs/js", true, function(Object_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.Object = null;
			return;
		}
		this.Object = Object_;
	});
	sliceType = $sliceType($emptyInterface);
	ptrType = $ptrType(Object);
	ptrType$1 = $ptrType(Error);
	Object.ptr.prototype.Get = function(key) {
		var key, o;
		o = this;
		return o.object[$externalize(key, $String)];
	};
	Object.prototype.Get = function(key) { return this.$val.Get(key); };
	Object.ptr.prototype.Set = function(key, value) {
		var key, o, value;
		o = this;
		o.object[$externalize(key, $String)] = $externalize(value, $emptyInterface);
	};
	Object.prototype.Set = function(key, value) { return this.$val.Set(key, value); };
	Object.ptr.prototype.Delete = function(key) {
		var key, o;
		o = this;
		delete o.object[$externalize(key, $String)];
	};
	Object.prototype.Delete = function(key) { return this.$val.Delete(key); };
	Object.ptr.prototype.Length = function() {
		var o;
		o = this;
		return $parseInt(o.object.length);
	};
	Object.prototype.Length = function() { return this.$val.Length(); };
	Object.ptr.prototype.Index = function(i) {
		var i, o;
		o = this;
		return o.object[i];
	};
	Object.prototype.Index = function(i) { return this.$val.Index(i); };
	Object.ptr.prototype.SetIndex = function(i, value) {
		var i, o, value;
		o = this;
		o.object[i] = $externalize(value, $emptyInterface);
	};
	Object.prototype.SetIndex = function(i, value) { return this.$val.SetIndex(i, value); };
	Object.ptr.prototype.Call = function(name, args) {
		var args, name, o, obj;
		o = this;
		return (obj = o.object, obj[$externalize(name, $String)].apply(obj, $externalize(args, sliceType)));
	};
	Object.prototype.Call = function(name, args) { return this.$val.Call(name, args); };
	Object.ptr.prototype.Invoke = function(args) {
		var args, o;
		o = this;
		return o.object.apply(undefined, $externalize(args, sliceType));
	};
	Object.prototype.Invoke = function(args) { return this.$val.Invoke(args); };
	Object.ptr.prototype.New = function(args) {
		var args, o;
		o = this;
		return new ($global.Function.prototype.bind.apply(o.object, [undefined].concat($externalize(args, sliceType))));
	};
	Object.prototype.New = function(args) { return this.$val.New(args); };
	Object.ptr.prototype.Bool = function() {
		var o;
		o = this;
		return !!(o.object);
	};
	Object.prototype.Bool = function() { return this.$val.Bool(); };
	Object.ptr.prototype.String = function() {
		var o;
		o = this;
		return $internalize(o.object, $String);
	};
	Object.prototype.String = function() { return this.$val.String(); };
	Object.ptr.prototype.Int = function() {
		var o;
		o = this;
		return $parseInt(o.object) >> 0;
	};
	Object.prototype.Int = function() { return this.$val.Int(); };
	Object.ptr.prototype.Int64 = function() {
		var o;
		o = this;
		return $internalize(o.object, $Int64);
	};
	Object.prototype.Int64 = function() { return this.$val.Int64(); };
	Object.ptr.prototype.Uint64 = function() {
		var o;
		o = this;
		return $internalize(o.object, $Uint64);
	};
	Object.prototype.Uint64 = function() { return this.$val.Uint64(); };
	Object.ptr.prototype.Float = function() {
		var o;
		o = this;
		return $parseFloat(o.object);
	};
	Object.prototype.Float = function() { return this.$val.Float(); };
	Object.ptr.prototype.Interface = function() {
		var o;
		o = this;
		return $internalize(o.object, $emptyInterface);
	};
	Object.prototype.Interface = function() { return this.$val.Interface(); };
	Object.ptr.prototype.Unsafe = function() {
		var o;
		o = this;
		return o.object;
	};
	Object.prototype.Unsafe = function() { return this.$val.Unsafe(); };
	Error.ptr.prototype.Error = function() {
		var err;
		err = this;
		return "JavaScript error: " + $internalize(err.Object.message, $String);
	};
	Error.prototype.Error = function() { return this.$val.Error(); };
	Error.ptr.prototype.Stack = function() {
		var err;
		err = this;
		return $internalize(err.Object.stack, $String);
	};
	Error.prototype.Stack = function() { return this.$val.Stack(); };
	MakeFunc = function(fn) {
		var fn;
		return $makeFunc(fn);
	};
	$pkg.MakeFunc = MakeFunc;
	init = function() {
		var e;
		e = new Error.ptr(null);
		$unused(e);
	};
	ptrType.methods = [{prop: "Get", name: "Get", pkg: "", typ: $funcType([$String], [ptrType], false)}, {prop: "Set", name: "Set", pkg: "", typ: $funcType([$String, $emptyInterface], [], false)}, {prop: "Delete", name: "Delete", pkg: "", typ: $funcType([$String], [], false)}, {prop: "Length", name: "Length", pkg: "", typ: $funcType([], [$Int], false)}, {prop: "Index", name: "Index", pkg: "", typ: $funcType([$Int], [ptrType], false)}, {prop: "SetIndex", name: "SetIndex", pkg: "", typ: $funcType([$Int, $emptyInterface], [], false)}, {prop: "Call", name: "Call", pkg: "", typ: $funcType([$String, sliceType], [ptrType], true)}, {prop: "Invoke", name: "Invoke", pkg: "", typ: $funcType([sliceType], [ptrType], true)}, {prop: "New", name: "New", pkg: "", typ: $funcType([sliceType], [ptrType], true)}, {prop: "Bool", name: "Bool", pkg: "", typ: $funcType([], [$Bool], false)}, {prop: "String", name: "String", pkg: "", typ: $funcType([], [$String], false)}, {prop: "Int", name: "Int", pkg: "", typ: $funcType([], [$Int], false)}, {prop: "Int64", name: "Int64", pkg: "", typ: $funcType([], [$Int64], false)}, {prop: "Uint64", name: "Uint64", pkg: "", typ: $funcType([], [$Uint64], false)}, {prop: "Float", name: "Float", pkg: "", typ: $funcType([], [$Float64], false)}, {prop: "Interface", name: "Interface", pkg: "", typ: $funcType([], [$emptyInterface], false)}, {prop: "Unsafe", name: "Unsafe", pkg: "", typ: $funcType([], [$Uintptr], false)}];
	ptrType$1.methods = [{prop: "Error", name: "Error", pkg: "", typ: $funcType([], [$String], false)}, {prop: "Stack", name: "Stack", pkg: "", typ: $funcType([], [$String], false)}];
	Object.init("github.com/gopherjs/gopherjs/js", [{prop: "object", name: "object", embedded: false, exported: false, typ: ptrType, tag: ""}]);
	Error.init("", [{prop: "Object", name: "Object", embedded: true, exported: true, typ: ptrType, tag: ""}]);
	$init = function() {
		$pkg.$init = function() {};
		/* */ var $f, $c = false, $s = 0, $r; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		init();
		/* */ } return; } if ($f === undefined) { $f = { $blk: $init }; } $f.$s = $s; $f.$r = $r; return $f;
	};
	$pkg.$init = $init;
	return $pkg;
})();
$packages["runtime"] = (function() {
	var $pkg = {}, $init, js, _type, TypeAssertionError, basicFrame, Frames, Frame, Func, errorString, ptrType, sliceType, ptrType$1, structType, sliceType$1, sliceType$2, ptrType$2, ptrType$3, knownPositions, positionCounters, hiddenFrames, knownFrames, buildVersion, init, registerPosition, itoa, callstack, parseCallstack, ParseCallFrame, Callers, CallersFrames, FuncForPC, throw$1, nanotime;
	js = $packages["github.com/gopherjs/gopherjs/js"];
	_type = $pkg._type = $newType(0, $kindStruct, "runtime._type", true, "runtime", false, function(str_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.str = "";
			return;
		}
		this.str = str_;
	});
	TypeAssertionError = $pkg.TypeAssertionError = $newType(0, $kindStruct, "runtime.TypeAssertionError", true, "runtime", true, function(_interface_, concrete_, asserted_, missingMethod_) {
		this.$val = this;
		if (arguments.length === 0) {
			this._interface = ptrType$1.nil;
			this.concrete = ptrType$1.nil;
			this.asserted = ptrType$1.nil;
			this.missingMethod = "";
			return;
		}
		this._interface = _interface_;
		this.concrete = concrete_;
		this.asserted = asserted_;
		this.missingMethod = missingMethod_;
	});
	basicFrame = $pkg.basicFrame = $newType(0, $kindStruct, "runtime.basicFrame", true, "runtime", false, function(FuncName_, File_, Line_, Col_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.FuncName = "";
			this.File = "";
			this.Line = 0;
			this.Col = 0;
			return;
		}
		this.FuncName = FuncName_;
		this.File = File_;
		this.Line = Line_;
		this.Col = Col_;
	});
	Frames = $pkg.Frames = $newType(0, $kindStruct, "runtime.Frames", true, "runtime", true, function(frames_, current_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.frames = sliceType$2.nil;
			this.current = 0;
			return;
		}
		this.frames = frames_;
		this.current = current_;
	});
	Frame = $pkg.Frame = $newType(0, $kindStruct, "runtime.Frame", true, "runtime", true, function(PC_, Func_, Function_, File_, Line_, Entry_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.PC = 0;
			this.Func = ptrType.nil;
			this.Function = "";
			this.File = "";
			this.Line = 0;
			this.Entry = 0;
			return;
		}
		this.PC = PC_;
		this.Func = Func_;
		this.Function = Function_;
		this.File = File_;
		this.Line = Line_;
		this.Entry = Entry_;
	});
	Func = $pkg.Func = $newType(0, $kindStruct, "runtime.Func", true, "runtime", true, function(name_, file_, line_, opaque_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.name = "";
			this.file = "";
			this.line = 0;
			this.opaque = new structType.ptr();
			return;
		}
		this.name = name_;
		this.file = file_;
		this.line = line_;
		this.opaque = opaque_;
	});
	errorString = $pkg.errorString = $newType(8, $kindString, "runtime.errorString", true, "runtime", false, null);
	ptrType = $ptrType(Func);
	sliceType = $sliceType(ptrType);
	ptrType$1 = $ptrType(_type);
	structType = $structType("", []);
	sliceType$1 = $sliceType(basicFrame);
	sliceType$2 = $sliceType(Frame);
	ptrType$2 = $ptrType(TypeAssertionError);
	ptrType$3 = $ptrType(Frames);
	_type.ptr.prototype.string = function() {
		var t;
		t = this;
		return t.str;
	};
	_type.prototype.string = function() { return this.$val.string(); };
	_type.ptr.prototype.pkgpath = function() {
		var t;
		t = this;
		return "";
	};
	_type.prototype.pkgpath = function() { return this.$val.pkgpath(); };
	TypeAssertionError.ptr.prototype.RuntimeError = function() {
	};
	TypeAssertionError.prototype.RuntimeError = function() { return this.$val.RuntimeError(); };
	TypeAssertionError.ptr.prototype.Error = function() {
		var as, cs, e, inter, msg;
		e = this;
		inter = "interface";
		if (!(e._interface === ptrType$1.nil)) {
			inter = e._interface.string();
		}
		as = e.asserted.string();
		if (e.concrete === ptrType$1.nil) {
			return "interface conversion: " + inter + " is nil, not " + as;
		}
		cs = e.concrete.string();
		if (e.missingMethod === "") {
			msg = "interface conversion: " + inter + " is " + cs + ", not " + as;
			if (cs === as) {
				if (!(e.concrete.pkgpath() === e.asserted.pkgpath())) {
					msg = msg + (" (types from different packages)");
				} else {
					msg = msg + (" (types from different scopes)");
				}
			}
			return msg;
		}
		return "interface conversion: " + cs + " is not " + as + ": missing method " + e.missingMethod;
	};
	TypeAssertionError.prototype.Error = function() { return this.$val.Error(); };
	init = function() {
		var e, jsPkg;
		jsPkg = $packages[$externalize("github.com/gopherjs/gopherjs/js", $String)];
		$jsObjectPtr = jsPkg.Object.ptr;
		$jsErrorPtr = jsPkg.Error.ptr;
		$throwRuntimeError = throw$1;
		buildVersion = $internalize($goVersion, $String);
		e = $ifaceNil;
		e = new TypeAssertionError.ptr(ptrType$1.nil, ptrType$1.nil, ptrType$1.nil, "");
		$unused(e);
	};
	registerPosition = function(funcName, file, line, col) {
		var _entry, _key, _tuple, col, f, file, found, funcName, key, line, pc, pc$1;
		key = file + ":" + itoa(line) + ":" + itoa(col);
		_tuple = (_entry = $mapIndex(knownPositions,$String.keyFor(key)), _entry !== undefined ? [_entry.v, true] : [0, false]);
		pc = _tuple[0];
		found = _tuple[1];
		if (found) {
			return pc;
		}
		f = new Func.ptr(funcName, file, line, new structType.ptr());
		pc$1 = ((positionCounters.$length >>> 0));
		positionCounters = $append(positionCounters, f);
		_key = key; (knownPositions || $throwRuntimeError("assignment to entry in nil map")).set($String.keyFor(_key), { k: _key, v: pc$1 });
		return pc$1;
	};
	itoa = function(i) {
		var i;
		return $internalize(new ($global.String)(i), $String);
	};
	callstack = function(skip, limit) {
		var limit, lines, skip;
		skip = (skip + 1 >> 0) + 1 >> 0;
		lines = new ($global.Error)().stack.split($externalize("\n", $String)).slice(skip, skip + limit >> 0);
		return parseCallstack(lines);
	};
	parseCallstack = function(lines) {
		var _entry, _entry$1, _tuple, alias, frame, frames, i, l, lines, ok;
		frames = new sliceType$1([]);
		l = $parseInt(lines.length);
		i = 0;
		while (true) {
			if (!(i < l)) { break; }
			frame = $clone(ParseCallFrame(lines[i]), basicFrame);
			if ((_entry = $mapIndex(hiddenFrames,$String.keyFor(frame.FuncName)), _entry !== undefined ? _entry.v : false)) {
				i = i + (1) >> 0;
				continue;
			}
			_tuple = (_entry$1 = $mapIndex(knownFrames,$String.keyFor(frame.FuncName)), _entry$1 !== undefined ? [_entry$1.v, true] : ["", false]);
			alias = _tuple[0];
			ok = _tuple[1];
			if (ok) {
				frame.FuncName = alias;
			}
			frames = $append(frames, frame);
			if (frame.FuncName === "runtime.goexit") {
				break;
			}
			i = i + (1) >> 0;
		}
		return frames;
	};
	ParseCallFrame = function(info) {
		var _tmp, _tmp$1, _tmp$2, _tmp$3, col, file, fn, funcName, idx, info, line, openIdx, parts, parts$1, parts$2, pos, split;
		if (($parseInt(info.indexOf($externalize("@", $String))) >> 0) >= 0) {
			split = new ($global.RegExp)($externalize("[@:]", $String));
			parts = info.split(split);
			return new basicFrame.ptr($internalize(parts[0], $String), $internalize(parts.slice(1, $parseInt(parts.length) - 2 >> 0).join($externalize(":", $String)), $String), $parseInt(parts[($parseInt(parts.length) - 2 >> 0)]) >> 0, $parseInt(parts[($parseInt(parts.length) - 1 >> 0)]) >> 0);
		}
		openIdx = $parseInt(info.lastIndexOf($externalize("(", $String))) >> 0;
		if (openIdx === -1) {
			parts$1 = info.split($externalize(":", $String));
			return new basicFrame.ptr("<none>", $internalize(parts$1.slice(0, $parseInt(parts$1.length) - 2 >> 0).join($externalize(":", $String)).replace(new ($global.RegExp)($externalize("^\\s*at ", $String)), $externalize("", $String)), $String), $parseInt(parts$1[($parseInt(parts$1.length) - 2 >> 0)]) >> 0, $parseInt(parts$1[($parseInt(parts$1.length) - 1 >> 0)]) >> 0);
		}
		_tmp = "";
		_tmp$1 = "";
		file = _tmp;
		funcName = _tmp$1;
		_tmp$2 = 0;
		_tmp$3 = 0;
		line = _tmp$2;
		col = _tmp$3;
		pos = info.substring(openIdx + 1 >> 0, $parseInt(info.indexOf($externalize(")", $String))) >> 0);
		parts$2 = pos.split($externalize(":", $String));
		if ($internalize(pos, $String) === "<anonymous>") {
			file = "<anonymous>";
		} else {
			file = $internalize(parts$2.slice(0, $parseInt(parts$2.length) - 2 >> 0).join($externalize(":", $String)), $String);
			line = $parseInt(parts$2[($parseInt(parts$2.length) - 2 >> 0)]) >> 0;
			col = $parseInt(parts$2[($parseInt(parts$2.length) - 1 >> 0)]) >> 0;
		}
		fn = info.substring(($parseInt(info.indexOf($externalize("at ", $String))) >> 0) + 3 >> 0, $parseInt(info.indexOf($externalize(" (", $String))) >> 0);
		idx = $parseInt(fn.indexOf($externalize("[as ", $String))) >> 0;
		if (idx > 0) {
			fn = fn.substring(idx + 4 >> 0, fn.indexOf($externalize("]", $String)));
		}
		funcName = $internalize(fn, $String);
		return new basicFrame.ptr(funcName, file, line, col);
	};
	$pkg.ParseCallFrame = ParseCallFrame;
	Callers = function(skip, pc) {
		var _i, _ref, frame, frames, i, pc, skip;
		frames = callstack(skip, pc.$length);
		_ref = frames;
		_i = 0;
		while (true) {
			if (!(_i < _ref.$length)) { break; }
			i = _i;
			frame = $clone(((_i < 0 || _i >= _ref.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref.$array[_ref.$offset + _i]), basicFrame);
			((i < 0 || i >= pc.$length) ? ($throwRuntimeError("index out of range"), undefined) : pc.$array[pc.$offset + i] = registerPosition(frame.FuncName, frame.File, frame.Line, frame.Col));
			_i++;
		}
		return frames.$length;
	};
	$pkg.Callers = Callers;
	CallersFrames = function(callers) {
		var _i, _ref, callers, fun, pc, result;
		result = new Frames.ptr(sliceType$2.nil, 0);
		_ref = callers;
		_i = 0;
		while (true) {
			if (!(_i < _ref.$length)) { break; }
			pc = ((_i < 0 || _i >= _ref.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref.$array[_ref.$offset + _i]);
			fun = FuncForPC(pc);
			result.frames = $append(result.frames, new Frame.ptr(pc, fun, fun.name, fun.file, fun.line, fun.Entry()));
			_i++;
		}
		return result;
	};
	$pkg.CallersFrames = CallersFrames;
	Frames.ptr.prototype.Next = function() {
		var _tmp, _tmp$1, _tmp$2, _tmp$3, ci, f, frame, more, x, x$1;
		frame = new Frame.ptr(0, ptrType.nil, "", "", 0, 0);
		more = false;
		ci = this;
		if (ci.current >= ci.frames.$length) {
			_tmp = new Frame.ptr(0, ptrType.nil, "", "", 0, 0);
			_tmp$1 = false;
			Frame.copy(frame, _tmp);
			more = _tmp$1;
			return [frame, more];
		}
		f = $clone((x = ci.frames, x$1 = ci.current, ((x$1 < 0 || x$1 >= x.$length) ? ($throwRuntimeError("index out of range"), undefined) : x.$array[x.$offset + x$1])), Frame);
		ci.current = ci.current + (1) >> 0;
		_tmp$2 = $clone(f, Frame);
		_tmp$3 = ci.current < ci.frames.$length;
		Frame.copy(frame, _tmp$2);
		more = _tmp$3;
		return [frame, more];
	};
	Frames.prototype.Next = function() { return this.$val.Next(); };
	Func.ptr.prototype.Entry = function() {
		return 0;
	};
	Func.prototype.Entry = function() { return this.$val.Entry(); };
	Func.ptr.prototype.FileLine = function(pc) {
		var _tmp, _tmp$1, _tmp$2, _tmp$3, f, file, line, pc;
		file = "";
		line = 0;
		f = this;
		if (f === ptrType.nil) {
			_tmp = "";
			_tmp$1 = 0;
			file = _tmp;
			line = _tmp$1;
			return [file, line];
		}
		_tmp$2 = f.file;
		_tmp$3 = f.line;
		file = _tmp$2;
		line = _tmp$3;
		return [file, line];
	};
	Func.prototype.FileLine = function(pc) { return this.$val.FileLine(pc); };
	Func.ptr.prototype.Name = function() {
		var f;
		f = this;
		if (f === ptrType.nil || f.name === "") {
			return "<unknown>";
		}
		return f.name;
	};
	Func.prototype.Name = function() { return this.$val.Name(); };
	FuncForPC = function(pc) {
		var ipc, pc;
		ipc = ((pc >> 0));
		if (ipc >= positionCounters.$length) {
			$panic(new $String("GopherJS: pc=" + itoa(ipc) + " is out of range of known position counters"));
		}
		return ((ipc < 0 || ipc >= positionCounters.$length) ? ($throwRuntimeError("index out of range"), undefined) : positionCounters.$array[positionCounters.$offset + ipc]);
	};
	$pkg.FuncForPC = FuncForPC;
	errorString.prototype.RuntimeError = function() {
		var e;
		e = this.$val;
	};
	$ptrType(errorString).prototype.RuntimeError = function() { return new errorString(this.$get()).RuntimeError(); };
	errorString.prototype.Error = function() {
		var e;
		e = this.$val;
		return "runtime error: " + (e);
	};
	$ptrType(errorString).prototype.Error = function() { return new errorString(this.$get()).Error(); };
	throw$1 = function(s) {
		var s;
		$panic(new errorString((s)));
	};
	nanotime = function() {
		return $mul64($internalize(new ($global.Date)().getTime(), $Int64), new $Int64(0, 1000000));
	};
	$linknames["runtime.nanotime"] = nanotime;
	ptrType$1.methods = [{prop: "string", name: "string", pkg: "runtime", typ: $funcType([], [$String], false)}, {prop: "pkgpath", name: "pkgpath", pkg: "runtime", typ: $funcType([], [$String], false)}];
	ptrType$2.methods = [{prop: "RuntimeError", name: "RuntimeError", pkg: "", typ: $funcType([], [], false)}, {prop: "Error", name: "Error", pkg: "", typ: $funcType([], [$String], false)}];
	ptrType$3.methods = [{prop: "Next", name: "Next", pkg: "", typ: $funcType([], [Frame, $Bool], false)}];
	ptrType.methods = [{prop: "Entry", name: "Entry", pkg: "", typ: $funcType([], [$Uintptr], false)}, {prop: "FileLine", name: "FileLine", pkg: "", typ: $funcType([$Uintptr], [$String, $Int], false)}, {prop: "Name", name: "Name", pkg: "", typ: $funcType([], [$String], false)}];
	errorString.methods = [{prop: "RuntimeError", name: "RuntimeError", pkg: "", typ: $funcType([], [], false)}, {prop: "Error", name: "Error", pkg: "", typ: $funcType([], [$String], false)}];
	_type.init("runtime", [{prop: "str", name: "str", embedded: false, exported: false, typ: $String, tag: ""}]);
	TypeAssertionError.init("runtime", [{prop: "_interface", name: "_interface", embedded: false, exported: false, typ: ptrType$1, tag: ""}, {prop: "concrete", name: "concrete", embedded: false, exported: false, typ: ptrType$1, tag: ""}, {prop: "asserted", name: "asserted", embedded: false, exported: false, typ: ptrType$1, tag: ""}, {prop: "missingMethod", name: "missingMethod", embedded: false, exported: false, typ: $String, tag: ""}]);
	basicFrame.init("", [{prop: "FuncName", name: "FuncName", embedded: false, exported: true, typ: $String, tag: ""}, {prop: "File", name: "File", embedded: false, exported: true, typ: $String, tag: ""}, {prop: "Line", name: "Line", embedded: false, exported: true, typ: $Int, tag: ""}, {prop: "Col", name: "Col", embedded: false, exported: true, typ: $Int, tag: ""}]);
	Frames.init("runtime", [{prop: "frames", name: "frames", embedded: false, exported: false, typ: sliceType$2, tag: ""}, {prop: "current", name: "current", embedded: false, exported: false, typ: $Int, tag: ""}]);
	Frame.init("", [{prop: "PC", name: "PC", embedded: false, exported: true, typ: $Uintptr, tag: ""}, {prop: "Func", name: "Func", embedded: false, exported: true, typ: ptrType, tag: ""}, {prop: "Function", name: "Function", embedded: false, exported: true, typ: $String, tag: ""}, {prop: "File", name: "File", embedded: false, exported: true, typ: $String, tag: ""}, {prop: "Line", name: "Line", embedded: false, exported: true, typ: $Int, tag: ""}, {prop: "Entry", name: "Entry", embedded: false, exported: true, typ: $Uintptr, tag: ""}]);
	Func.init("runtime", [{prop: "name", name: "name", embedded: false, exported: false, typ: $String, tag: ""}, {prop: "file", name: "file", embedded: false, exported: false, typ: $String, tag: ""}, {prop: "line", name: "line", embedded: false, exported: false, typ: $Int, tag: ""}, {prop: "opaque", name: "opaque", embedded: false, exported: false, typ: structType, tag: ""}]);
	$init = function() {
		$pkg.$init = function() {};
		/* */ var $f, $c = false, $s = 0, $r; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		$r = js.$init(); /* */ $s = 1; case 1: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		buildVersion = "";
		knownPositions = $makeMap($String.keyFor, []);
		positionCounters = new sliceType([]);
		hiddenFrames = $makeMap($String.keyFor, [{ k: "$callDeferred", v: true }]);
		knownFrames = $makeMap($String.keyFor, [{ k: "$panic", v: "runtime.gopanic" }, { k: "$goroutine", v: "runtime.goexit" }]);
		init();
		/* */ } return; } if ($f === undefined) { $f = { $blk: $init }; } $f.$s = $s; $f.$r = $r; return $f;
	};
	$pkg.$init = $init;
	return $pkg;
})();
$packages["internal/goarch"] = (function() {
	var $pkg = {}, $init;
	$init = function() {
		$pkg.$init = function() {};
		/* */ var $f, $c = false, $s = 0, $r; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		/* */ } return; } if ($f === undefined) { $f = { $blk: $init }; } $f.$s = $s; $f.$r = $r; return $f;
	};
	$pkg.$init = $init;
	return $pkg;
})();
$packages["internal/reflectlite"] = (function() {
	var $pkg = {}, $init, js, goarch, Value, flag, ValueError, Type, Kind, tflag, rtype, method, chanDir, arrayType, chanType, imethod, interfaceType, mapType, ptrType, sliceType, structField, structType, nameOff, typeOff, textOff, errorString, Method, uncommonType, funcType, name, nameData, mapIter, TypeEx, ptrType$1, sliceType$1, sliceType$2, sliceType$3, sliceType$4, ptrType$2, funcType$1, ptrType$4, sliceType$5, ptrType$5, sliceType$6, ptrType$6, ptrType$7, sliceType$7, sliceType$8, sliceType$9, sliceType$10, ptrType$8, structType$2, ptrType$9, arrayType$2, sliceType$13, ptrType$10, funcType$2, ptrType$11, funcType$3, ptrType$12, ptrType$13, kindNames, callHelper, initialized, uint8Type, idJsType, idReflectType, idKindType, idRtype, uncommonTypeMap, nameMap, nameOffList, typeOffList, jsObjectPtr, selectHelper, implements$1, directlyAssignable, haveIdenticalType, haveIdenticalUnderlyingType, toType, ifaceIndir, unquote, init, jsType, reflectType, setKindType, newName, newNameOff, newTypeOff, internalStr, isWrapped, copyStruct, makeValue, TypeOf, ValueOf, FuncOf, SliceOf, unsafe_New, typedmemmove, keyFor, mapaccess, mapiterinit, mapiterkey, mapiternext, maplen, methodReceiver, valueInterface, ifaceE2I, methodName, makeMethodValue, wrapJsObject, unwrapJsObject, getJsTag, PtrTo, copyVal;
	js = $packages["github.com/gopherjs/gopherjs/js"];
	goarch = $packages["internal/goarch"];
	Value = $pkg.Value = $newType(0, $kindStruct, "reflectlite.Value", true, "internal/reflectlite", true, function(typ_, ptr_, flag_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.typ = ptrType$1.nil;
			this.ptr = 0;
			this.flag = 0;
			return;
		}
		this.typ = typ_;
		this.ptr = ptr_;
		this.flag = flag_;
	});
	flag = $pkg.flag = $newType(4, $kindUintptr, "reflectlite.flag", true, "internal/reflectlite", false, null);
	ValueError = $pkg.ValueError = $newType(0, $kindStruct, "reflectlite.ValueError", true, "internal/reflectlite", true, function(Method_, Kind_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.Method = "";
			this.Kind = 0;
			return;
		}
		this.Method = Method_;
		this.Kind = Kind_;
	});
	Type = $pkg.Type = $newType(8, $kindInterface, "reflectlite.Type", true, "internal/reflectlite", true, null);
	Kind = $pkg.Kind = $newType(4, $kindUint, "reflectlite.Kind", true, "internal/reflectlite", true, null);
	tflag = $pkg.tflag = $newType(1, $kindUint8, "reflectlite.tflag", true, "internal/reflectlite", false, null);
	rtype = $pkg.rtype = $newType(0, $kindStruct, "reflectlite.rtype", true, "internal/reflectlite", false, function(size_, ptrdata_, hash_, tflag_, align_, fieldAlign_, kind_, equal_, gcdata_, str_, ptrToThis_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.size = 0;
			this.ptrdata = 0;
			this.hash = 0;
			this.tflag = 0;
			this.align = 0;
			this.fieldAlign = 0;
			this.kind = 0;
			this.equal = $throwNilPointerError;
			this.gcdata = ptrType$6.nil;
			this.str = 0;
			this.ptrToThis = 0;
			return;
		}
		this.size = size_;
		this.ptrdata = ptrdata_;
		this.hash = hash_;
		this.tflag = tflag_;
		this.align = align_;
		this.fieldAlign = fieldAlign_;
		this.kind = kind_;
		this.equal = equal_;
		this.gcdata = gcdata_;
		this.str = str_;
		this.ptrToThis = ptrToThis_;
	});
	method = $pkg.method = $newType(0, $kindStruct, "reflectlite.method", true, "internal/reflectlite", false, function(name_, mtyp_, ifn_, tfn_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.name = 0;
			this.mtyp = 0;
			this.ifn = 0;
			this.tfn = 0;
			return;
		}
		this.name = name_;
		this.mtyp = mtyp_;
		this.ifn = ifn_;
		this.tfn = tfn_;
	});
	chanDir = $pkg.chanDir = $newType(4, $kindInt, "reflectlite.chanDir", true, "internal/reflectlite", false, null);
	arrayType = $pkg.arrayType = $newType(0, $kindStruct, "reflectlite.arrayType", true, "internal/reflectlite", false, function(rtype_, elem_, slice_, len_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.rtype = new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$6.nil, 0, 0);
			this.elem = ptrType$1.nil;
			this.slice = ptrType$1.nil;
			this.len = 0;
			return;
		}
		this.rtype = rtype_;
		this.elem = elem_;
		this.slice = slice_;
		this.len = len_;
	});
	chanType = $pkg.chanType = $newType(0, $kindStruct, "reflectlite.chanType", true, "internal/reflectlite", false, function(rtype_, elem_, dir_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.rtype = new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$6.nil, 0, 0);
			this.elem = ptrType$1.nil;
			this.dir = 0;
			return;
		}
		this.rtype = rtype_;
		this.elem = elem_;
		this.dir = dir_;
	});
	imethod = $pkg.imethod = $newType(0, $kindStruct, "reflectlite.imethod", true, "internal/reflectlite", false, function(name_, typ_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.name = 0;
			this.typ = 0;
			return;
		}
		this.name = name_;
		this.typ = typ_;
	});
	interfaceType = $pkg.interfaceType = $newType(0, $kindStruct, "reflectlite.interfaceType", true, "internal/reflectlite", false, function(rtype_, pkgPath_, methods_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.rtype = new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$6.nil, 0, 0);
			this.pkgPath = new name.ptr(ptrType$6.nil);
			this.methods = sliceType$9.nil;
			return;
		}
		this.rtype = rtype_;
		this.pkgPath = pkgPath_;
		this.methods = methods_;
	});
	mapType = $pkg.mapType = $newType(0, $kindStruct, "reflectlite.mapType", true, "internal/reflectlite", false, function(rtype_, key_, elem_, bucket_, hasher_, keysize_, valuesize_, bucketsize_, flags_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.rtype = new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$6.nil, 0, 0);
			this.key = ptrType$1.nil;
			this.elem = ptrType$1.nil;
			this.bucket = ptrType$1.nil;
			this.hasher = $throwNilPointerError;
			this.keysize = 0;
			this.valuesize = 0;
			this.bucketsize = 0;
			this.flags = 0;
			return;
		}
		this.rtype = rtype_;
		this.key = key_;
		this.elem = elem_;
		this.bucket = bucket_;
		this.hasher = hasher_;
		this.keysize = keysize_;
		this.valuesize = valuesize_;
		this.bucketsize = bucketsize_;
		this.flags = flags_;
	});
	ptrType = $pkg.ptrType = $newType(0, $kindStruct, "reflectlite.ptrType", true, "internal/reflectlite", false, function(rtype_, elem_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.rtype = new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$6.nil, 0, 0);
			this.elem = ptrType$1.nil;
			return;
		}
		this.rtype = rtype_;
		this.elem = elem_;
	});
	sliceType = $pkg.sliceType = $newType(0, $kindStruct, "reflectlite.sliceType", true, "internal/reflectlite", false, function(rtype_, elem_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.rtype = new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$6.nil, 0, 0);
			this.elem = ptrType$1.nil;
			return;
		}
		this.rtype = rtype_;
		this.elem = elem_;
	});
	structField = $pkg.structField = $newType(0, $kindStruct, "reflectlite.structField", true, "internal/reflectlite", false, function(name_, typ_, offset_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.name = new name.ptr(ptrType$6.nil);
			this.typ = ptrType$1.nil;
			this.offset = 0;
			return;
		}
		this.name = name_;
		this.typ = typ_;
		this.offset = offset_;
	});
	structType = $pkg.structType = $newType(0, $kindStruct, "reflectlite.structType", true, "internal/reflectlite", false, function(rtype_, pkgPath_, fields_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.rtype = new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$6.nil, 0, 0);
			this.pkgPath = new name.ptr(ptrType$6.nil);
			this.fields = sliceType$10.nil;
			return;
		}
		this.rtype = rtype_;
		this.pkgPath = pkgPath_;
		this.fields = fields_;
	});
	nameOff = $pkg.nameOff = $newType(4, $kindInt32, "reflectlite.nameOff", true, "internal/reflectlite", false, null);
	typeOff = $pkg.typeOff = $newType(4, $kindInt32, "reflectlite.typeOff", true, "internal/reflectlite", false, null);
	textOff = $pkg.textOff = $newType(4, $kindInt32, "reflectlite.textOff", true, "internal/reflectlite", false, null);
	errorString = $pkg.errorString = $newType(0, $kindStruct, "reflectlite.errorString", true, "internal/reflectlite", false, function(s_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.s = "";
			return;
		}
		this.s = s_;
	});
	Method = $pkg.Method = $newType(0, $kindStruct, "reflectlite.Method", true, "internal/reflectlite", true, function(Name_, PkgPath_, Type_, Func_, Index_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.Name = "";
			this.PkgPath = "";
			this.Type = $ifaceNil;
			this.Func = new Value.ptr(ptrType$1.nil, 0, 0);
			this.Index = 0;
			return;
		}
		this.Name = Name_;
		this.PkgPath = PkgPath_;
		this.Type = Type_;
		this.Func = Func_;
		this.Index = Index_;
	});
	uncommonType = $pkg.uncommonType = $newType(0, $kindStruct, "reflectlite.uncommonType", true, "internal/reflectlite", false, function(pkgPath_, mcount_, xcount_, moff_, _methods_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.pkgPath = 0;
			this.mcount = 0;
			this.xcount = 0;
			this.moff = 0;
			this._methods = sliceType$5.nil;
			return;
		}
		this.pkgPath = pkgPath_;
		this.mcount = mcount_;
		this.xcount = xcount_;
		this.moff = moff_;
		this._methods = _methods_;
	});
	funcType = $pkg.funcType = $newType(0, $kindStruct, "reflectlite.funcType", true, "internal/reflectlite", false, function(rtype_, inCount_, outCount_, _in_, _out_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.rtype = new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$6.nil, 0, 0);
			this.inCount = 0;
			this.outCount = 0;
			this._in = sliceType$2.nil;
			this._out = sliceType$2.nil;
			return;
		}
		this.rtype = rtype_;
		this.inCount = inCount_;
		this.outCount = outCount_;
		this._in = _in_;
		this._out = _out_;
	});
	name = $pkg.name = $newType(0, $kindStruct, "reflectlite.name", true, "internal/reflectlite", false, function(bytes_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.bytes = ptrType$6.nil;
			return;
		}
		this.bytes = bytes_;
	});
	nameData = $pkg.nameData = $newType(0, $kindStruct, "reflectlite.nameData", true, "internal/reflectlite", false, function(name_, tag_, exported_, embedded_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.name = "";
			this.tag = "";
			this.exported = false;
			this.embedded = false;
			return;
		}
		this.name = name_;
		this.tag = tag_;
		this.exported = exported_;
		this.embedded = embedded_;
	});
	mapIter = $pkg.mapIter = $newType(0, $kindStruct, "reflectlite.mapIter", true, "internal/reflectlite", false, function(t_, m_, keys_, i_, last_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.t = $ifaceNil;
			this.m = null;
			this.keys = null;
			this.i = 0;
			this.last = null;
			return;
		}
		this.t = t_;
		this.m = m_;
		this.keys = keys_;
		this.i = i_;
		this.last = last_;
	});
	TypeEx = $pkg.TypeEx = $newType(8, $kindInterface, "reflectlite.TypeEx", true, "internal/reflectlite", true, null);
	ptrType$1 = $ptrType(rtype);
	sliceType$1 = $sliceType(name);
	sliceType$2 = $sliceType(ptrType$1);
	sliceType$3 = $sliceType($String);
	sliceType$4 = $sliceType($emptyInterface);
	ptrType$2 = $ptrType(js.Object);
	funcType$1 = $funcType([sliceType$4], [ptrType$2], true);
	ptrType$4 = $ptrType(uncommonType);
	sliceType$5 = $sliceType(method);
	ptrType$5 = $ptrType(funcType);
	sliceType$6 = $sliceType(Value);
	ptrType$6 = $ptrType($Uint8);
	ptrType$7 = $ptrType($UnsafePointer);
	sliceType$7 = $sliceType(Type);
	sliceType$8 = $sliceType(ptrType$2);
	sliceType$9 = $sliceType(imethod);
	sliceType$10 = $sliceType(structField);
	ptrType$8 = $ptrType(nameData);
	structType$2 = $structType("internal/reflectlite", [{prop: "str", name: "str", embedded: false, exported: false, typ: $String, tag: ""}]);
	ptrType$9 = $ptrType(mapIter);
	arrayType$2 = $arrayType($Uintptr, 2);
	sliceType$13 = $sliceType($Uint8);
	ptrType$10 = $ptrType(ValueError);
	funcType$2 = $funcType([$UnsafePointer, $UnsafePointer], [$Bool], false);
	ptrType$11 = $ptrType(interfaceType);
	funcType$3 = $funcType([$UnsafePointer, $Uintptr], [$Uintptr], false);
	ptrType$12 = $ptrType(structField);
	ptrType$13 = $ptrType(errorString);
	flag.prototype.kind = function() {
		var f;
		f = this.$val;
		return ((((f & 31) >>> 0) >>> 0));
	};
	$ptrType(flag).prototype.kind = function() { return new flag(this.$get()).kind(); };
	flag.prototype.ro = function() {
		var f;
		f = this.$val;
		if (!((((f & 96) >>> 0) === 0))) {
			return 32;
		}
		return 0;
	};
	$ptrType(flag).prototype.ro = function() { return new flag(this.$get()).ro(); };
	Value.ptr.prototype.pointer = function() {
		var v;
		v = this;
		if (!((v.typ.size === 4)) || !v.typ.pointers()) {
			$panic(new $String("can't call pointer on a non-pointer Value"));
		}
		if (!((((v.flag & 128) >>> 0) === 0))) {
			return (v.ptr).$get();
		}
		return v.ptr;
	};
	Value.prototype.pointer = function() { return this.$val.pointer(); };
	ValueError.ptr.prototype.Error = function() {
		var e;
		e = this;
		if (e.Kind === 0) {
			return "reflect: call of " + e.Method + " on zero Value";
		}
		return "reflect: call of " + e.Method + " on " + new Kind(e.Kind).String() + " Value";
	};
	ValueError.prototype.Error = function() { return this.$val.Error(); };
	flag.prototype.mustBeExported = function() {
		var f;
		f = this.$val;
		if (f === 0) {
			$panic(new ValueError.ptr(methodName(), 0));
		}
		if (!((((f & 96) >>> 0) === 0))) {
			$panic(new $String("reflect: " + methodName() + " using value obtained using unexported field"));
		}
	};
	$ptrType(flag).prototype.mustBeExported = function() { return new flag(this.$get()).mustBeExported(); };
	flag.prototype.mustBeAssignable = function() {
		var f;
		f = this.$val;
		if (f === 0) {
			$panic(new ValueError.ptr(methodName(), 0));
		}
		if (!((((f & 96) >>> 0) === 0))) {
			$panic(new $String("reflect: " + methodName() + " using value obtained using unexported field"));
		}
		if (((f & 256) >>> 0) === 0) {
			$panic(new $String("reflect: " + methodName() + " using unaddressable value"));
		}
	};
	$ptrType(flag).prototype.mustBeAssignable = function() { return new flag(this.$get()).mustBeAssignable(); };
	Value.ptr.prototype.CanSet = function() {
		var v;
		v = this;
		return ((v.flag & 352) >>> 0) === 256;
	};
	Value.prototype.CanSet = function() { return this.$val.CanSet(); };
	Value.ptr.prototype.IsValid = function() {
		var v;
		v = this;
		return !((v.flag === 0));
	};
	Value.prototype.IsValid = function() { return this.$val.IsValid(); };
	Value.ptr.prototype.Kind = function() {
		var v;
		v = this;
		return new flag(v.flag).kind();
	};
	Value.prototype.Kind = function() { return this.$val.Kind(); };
	Value.ptr.prototype.Type = function() {
		var f, v;
		v = this;
		f = v.flag;
		if (f === 0) {
			$panic(new ValueError.ptr("reflectlite.Value.Type", 0));
		}
		return v.typ;
	};
	Value.prototype.Type = function() { return this.$val.Type(); };
	structField.ptr.prototype.embedded = function() {
		var f;
		f = this;
		return $clone(f.name, name).embedded();
	};
	structField.prototype.embedded = function() { return this.$val.embedded(); };
	Kind.prototype.String = function() {
		var k;
		k = this.$val;
		if (((k >> 0)) < kindNames.$length) {
			return ((k < 0 || k >= kindNames.$length) ? ($throwRuntimeError("index out of range"), undefined) : kindNames.$array[kindNames.$offset + k]);
		}
		return (0 >= kindNames.$length ? ($throwRuntimeError("index out of range"), undefined) : kindNames.$array[kindNames.$offset + 0]);
	};
	$ptrType(Kind).prototype.String = function() { return new Kind(this.$get()).String(); };
	rtype.ptr.prototype.String = function() {
		var s, t;
		t = this;
		s = $clone(t.nameOff(t.str), name).name();
		if (!((((t.tflag & 2) >>> 0) === 0))) {
			return $substring(s, 1);
		}
		return s;
	};
	rtype.prototype.String = function() { return this.$val.String(); };
	rtype.ptr.prototype.Size = function() {
		var t;
		t = this;
		return t.size;
	};
	rtype.prototype.Size = function() { return this.$val.Size(); };
	rtype.ptr.prototype.Kind = function() {
		var t;
		t = this;
		return ((((t.kind & 31) >>> 0) >>> 0));
	};
	rtype.prototype.Kind = function() { return this.$val.Kind(); };
	rtype.ptr.prototype.pointers = function() {
		var t;
		t = this;
		return !((t.ptrdata === 0));
	};
	rtype.prototype.pointers = function() { return this.$val.pointers(); };
	rtype.ptr.prototype.common = function() {
		var t;
		t = this;
		return t;
	};
	rtype.prototype.common = function() { return this.$val.common(); };
	rtype.ptr.prototype.exportedMethods = function() {
		var t, ut;
		t = this;
		ut = t.uncommon();
		if (ut === ptrType$4.nil) {
			return sliceType$5.nil;
		}
		return ut.exportedMethods();
	};
	rtype.prototype.exportedMethods = function() { return this.$val.exportedMethods(); };
	rtype.ptr.prototype.NumMethod = function() {
		var t, tt;
		t = this;
		if (t.Kind() === 20) {
			tt = (t.kindType);
			return tt.NumMethod();
		}
		return t.exportedMethods().$length;
	};
	rtype.prototype.NumMethod = function() { return this.$val.NumMethod(); };
	rtype.ptr.prototype.PkgPath = function() {
		var t, ut;
		t = this;
		if (((t.tflag & 4) >>> 0) === 0) {
			return "";
		}
		ut = t.uncommon();
		if (ut === ptrType$4.nil) {
			return "";
		}
		return $clone(t.nameOff(ut.pkgPath), name).name();
	};
	rtype.prototype.PkgPath = function() { return this.$val.PkgPath(); };
	rtype.ptr.prototype.hasName = function() {
		var t;
		t = this;
		return !((((t.tflag & 4) >>> 0) === 0));
	};
	rtype.prototype.hasName = function() { return this.$val.hasName(); };
	rtype.ptr.prototype.Name = function() {
		var _1, i, s, sqBrackets, t;
		t = this;
		if (!t.hasName()) {
			return "";
		}
		s = t.String();
		i = s.length - 1 >> 0;
		sqBrackets = 0;
		while (true) {
			if (!(i >= 0 && (!((s.charCodeAt(i) === 46)) || !((sqBrackets === 0))))) { break; }
			_1 = s.charCodeAt(i);
			if (_1 === (93)) {
				sqBrackets = sqBrackets + (1) >> 0;
			} else if (_1 === (91)) {
				sqBrackets = sqBrackets - (1) >> 0;
			}
			i = i - (1) >> 0;
		}
		return $substring(s, (i + 1 >> 0));
	};
	rtype.prototype.Name = function() { return this.$val.Name(); };
	rtype.ptr.prototype.chanDir = function() {
		var t, tt;
		t = this;
		if (!((t.Kind() === 18))) {
			$panic(new $String("reflect: chanDir of non-chan type"));
		}
		tt = (t.kindType);
		return ((tt.dir >> 0));
	};
	rtype.prototype.chanDir = function() { return this.$val.chanDir(); };
	rtype.ptr.prototype.Elem = function() {
		var _1, t, tt, tt$1, tt$2, tt$3, tt$4;
		t = this;
		_1 = t.Kind();
		if (_1 === (17)) {
			tt = (t.kindType);
			return toType(tt.elem);
		} else if (_1 === (18)) {
			tt$1 = (t.kindType);
			return toType(tt$1.elem);
		} else if (_1 === (21)) {
			tt$2 = (t.kindType);
			return toType(tt$2.elem);
		} else if (_1 === (22)) {
			tt$3 = (t.kindType);
			return toType(tt$3.elem);
		} else if (_1 === (23)) {
			tt$4 = (t.kindType);
			return toType(tt$4.elem);
		}
		$panic(new $String("reflect: Elem of invalid type"));
	};
	rtype.prototype.Elem = function() { return this.$val.Elem(); };
	rtype.ptr.prototype.In = function(i) {
		var i, t, tt, x;
		t = this;
		if (!((t.Kind() === 19))) {
			$panic(new $String("reflect: In of non-func type"));
		}
		tt = (t.kindType);
		return toType((x = tt.in$(), ((i < 0 || i >= x.$length) ? ($throwRuntimeError("index out of range"), undefined) : x.$array[x.$offset + i])));
	};
	rtype.prototype.In = function(i) { return this.$val.In(i); };
	rtype.ptr.prototype.Len = function() {
		var t, tt;
		t = this;
		if (!((t.Kind() === 17))) {
			$panic(new $String("reflect: Len of non-array type"));
		}
		tt = (t.kindType);
		return ((tt.len >> 0));
	};
	rtype.prototype.Len = function() { return this.$val.Len(); };
	rtype.ptr.prototype.NumIn = function() {
		var t, tt;
		t = this;
		if (!((t.Kind() === 19))) {
			$panic(new $String("reflect: NumIn of non-func type"));
		}
		tt = (t.kindType);
		return ((tt.inCount >> 0));
	};
	rtype.prototype.NumIn = function() { return this.$val.NumIn(); };
	rtype.ptr.prototype.NumOut = function() {
		var t, tt;
		t = this;
		if (!((t.Kind() === 19))) {
			$panic(new $String("reflect: NumOut of non-func type"));
		}
		tt = (t.kindType);
		return tt.out().$length;
	};
	rtype.prototype.NumOut = function() { return this.$val.NumOut(); };
	rtype.ptr.prototype.Out = function(i) {
		var i, t, tt, x;
		t = this;
		if (!((t.Kind() === 19))) {
			$panic(new $String("reflect: Out of non-func type"));
		}
		tt = (t.kindType);
		return toType((x = tt.out(), ((i < 0 || i >= x.$length) ? ($throwRuntimeError("index out of range"), undefined) : x.$array[x.$offset + i])));
	};
	rtype.prototype.Out = function(i) { return this.$val.Out(i); };
	interfaceType.ptr.prototype.NumMethod = function() {
		var t;
		t = this;
		return t.methods.$length;
	};
	interfaceType.prototype.NumMethod = function() { return this.$val.NumMethod(); };
	rtype.ptr.prototype.Implements = function(u) {
		var {_r, t, u, $s, $r, $c} = $restore(this, {u});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		t = this;
		if ($interfaceIsEqual(u, $ifaceNil)) {
			$panic(new $String("reflect: nil type passed to Type.Implements"));
		}
		_r = u.Kind(); /* */ $s = 3; case 3: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		/* */ if (!((_r === 20))) { $s = 1; continue; }
		/* */ $s = 2; continue;
		/* if (!((_r === 20))) { */ case 1:
			$panic(new $String("reflect: non-interface type passed to Type.Implements"));
		/* } */ case 2:
		$s = -1; return implements$1($assertType(u, ptrType$1), t);
		/* */ } return; } var $f = {$blk: rtype.ptr.prototype.Implements, $c: true, $r, _r, t, u, $s};return $f;
	};
	rtype.prototype.Implements = function(u) { return this.$val.Implements(u); };
	rtype.ptr.prototype.AssignableTo = function(u) {
		var {$24r, _r, t, u, uu, $s, $r, $c} = $restore(this, {u});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		t = this;
		if ($interfaceIsEqual(u, $ifaceNil)) {
			$panic(new $String("reflect: nil type passed to Type.AssignableTo"));
		}
		uu = $assertType(u, ptrType$1);
		_r = directlyAssignable(uu, t); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		$24r = _r || implements$1(uu, t);
		$s = 2; case 2: return $24r;
		/* */ } return; } var $f = {$blk: rtype.ptr.prototype.AssignableTo, $c: true, $r, $24r, _r, t, u, uu, $s};return $f;
	};
	rtype.prototype.AssignableTo = function(u) { return this.$val.AssignableTo(u); };
	implements$1 = function(T, V) {
		var T, V, i, i$1, j, j$1, t, tm, tm$1, tmName, tmName$1, tmPkgPath, tmPkgPath$1, v, v$1, vm, vm$1, vmName, vmName$1, vmPkgPath, vmPkgPath$1, vmethods, x, x$1, x$2;
		if (!((T.Kind() === 20))) {
			return false;
		}
		t = (T.kindType);
		if (t.methods.$length === 0) {
			return true;
		}
		if (V.Kind() === 20) {
			v = (V.kindType);
			i = 0;
			j = 0;
			while (true) {
				if (!(j < v.methods.$length)) { break; }
				tm = (x = t.methods, ((i < 0 || i >= x.$length) ? ($throwRuntimeError("index out of range"), undefined) : x.$array[x.$offset + i]));
				tmName = $clone(t.rtype.nameOff(tm.name), name);
				vm = (x$1 = v.methods, ((j < 0 || j >= x$1.$length) ? ($throwRuntimeError("index out of range"), undefined) : x$1.$array[x$1.$offset + j]));
				vmName = $clone(V.nameOff(vm.name), name);
				if ($clone(vmName, name).name() === $clone(tmName, name).name() && V.typeOff(vm.typ) === t.rtype.typeOff(tm.typ)) {
					if (!$clone(tmName, name).isExported()) {
						tmPkgPath = $clone(tmName, name).pkgPath();
						if (tmPkgPath === "") {
							tmPkgPath = $clone(t.pkgPath, name).name();
						}
						vmPkgPath = $clone(vmName, name).pkgPath();
						if (vmPkgPath === "") {
							vmPkgPath = $clone(v.pkgPath, name).name();
						}
						if (!(tmPkgPath === vmPkgPath)) {
							j = j + (1) >> 0;
							continue;
						}
					}
					i = i + (1) >> 0;
					if (i >= t.methods.$length) {
						return true;
					}
				}
				j = j + (1) >> 0;
			}
			return false;
		}
		v$1 = V.uncommon();
		if (v$1 === ptrType$4.nil) {
			return false;
		}
		i$1 = 0;
		vmethods = v$1.methods();
		j$1 = 0;
		while (true) {
			if (!(j$1 < ((v$1.mcount >> 0)))) { break; }
			tm$1 = (x$2 = t.methods, ((i$1 < 0 || i$1 >= x$2.$length) ? ($throwRuntimeError("index out of range"), undefined) : x$2.$array[x$2.$offset + i$1]));
			tmName$1 = $clone(t.rtype.nameOff(tm$1.name), name);
			vm$1 = $clone(((j$1 < 0 || j$1 >= vmethods.$length) ? ($throwRuntimeError("index out of range"), undefined) : vmethods.$array[vmethods.$offset + j$1]), method);
			vmName$1 = $clone(V.nameOff(vm$1.name), name);
			if ($clone(vmName$1, name).name() === $clone(tmName$1, name).name() && V.typeOff(vm$1.mtyp) === t.rtype.typeOff(tm$1.typ)) {
				if (!$clone(tmName$1, name).isExported()) {
					tmPkgPath$1 = $clone(tmName$1, name).pkgPath();
					if (tmPkgPath$1 === "") {
						tmPkgPath$1 = $clone(t.pkgPath, name).name();
					}
					vmPkgPath$1 = $clone(vmName$1, name).pkgPath();
					if (vmPkgPath$1 === "") {
						vmPkgPath$1 = $clone(V.nameOff(v$1.pkgPath), name).name();
					}
					if (!(tmPkgPath$1 === vmPkgPath$1)) {
						j$1 = j$1 + (1) >> 0;
						continue;
					}
				}
				i$1 = i$1 + (1) >> 0;
				if (i$1 >= t.methods.$length) {
					return true;
				}
			}
			j$1 = j$1 + (1) >> 0;
		}
		return false;
	};
	directlyAssignable = function(T, V) {
		var {$24r, T, V, _r, $s, $r, $c} = $restore(this, {T, V});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		if (T === V) {
			$s = -1; return true;
		}
		if (T.hasName() && V.hasName() || !((T.Kind() === V.Kind()))) {
			$s = -1; return false;
		}
		_r = haveIdenticalUnderlyingType(T, V, true); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		$24r = _r;
		$s = 2; case 2: return $24r;
		/* */ } return; } var $f = {$blk: directlyAssignable, $c: true, $r, $24r, T, V, _r, $s};return $f;
	};
	haveIdenticalType = function(T, V, cmpTags) {
		var {$24r, T, V, _arg, _arg$1, _r, _r$1, _r$2, _r$3, _r$4, _r$5, _r$6, _v, cmpTags, $s, $r, $c} = $restore(this, {T, V, cmpTags});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		if (cmpTags) {
			$s = -1; return $interfaceIsEqual(T, V);
		}
		_r = T.Name(); /* */ $s = 4; case 4: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		_r$1 = V.Name(); /* */ $s = 5; case 5: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
		if (!(_r === _r$1)) { _v = true; $s = 3; continue s; }
		_r$2 = T.Kind(); /* */ $s = 6; case 6: if($c) { $c = false; _r$2 = _r$2.$blk(); } if (_r$2 && _r$2.$blk !== undefined) { break s; }
		_r$3 = V.Kind(); /* */ $s = 7; case 7: if($c) { $c = false; _r$3 = _r$3.$blk(); } if (_r$3 && _r$3.$blk !== undefined) { break s; }
		_v = !((_r$2 === _r$3)); case 3:
		/* */ if (_v) { $s = 1; continue; }
		/* */ $s = 2; continue;
		/* if (_v) { */ case 1:
			$s = -1; return false;
		/* } */ case 2:
		_r$4 = T.common(); /* */ $s = 8; case 8: if($c) { $c = false; _r$4 = _r$4.$blk(); } if (_r$4 && _r$4.$blk !== undefined) { break s; }
		_arg = _r$4;
		_r$5 = V.common(); /* */ $s = 9; case 9: if($c) { $c = false; _r$5 = _r$5.$blk(); } if (_r$5 && _r$5.$blk !== undefined) { break s; }
		_arg$1 = _r$5;
		_r$6 = haveIdenticalUnderlyingType(_arg, _arg$1, false); /* */ $s = 10; case 10: if($c) { $c = false; _r$6 = _r$6.$blk(); } if (_r$6 && _r$6.$blk !== undefined) { break s; }
		$24r = _r$6;
		$s = 11; case 11: return $24r;
		/* */ } return; } var $f = {$blk: haveIdenticalType, $c: true, $r, $24r, T, V, _arg, _arg$1, _r, _r$1, _r$2, _r$3, _r$4, _r$5, _r$6, _v, cmpTags, $s};return $f;
	};
	haveIdenticalUnderlyingType = function(T, V, cmpTags) {
		var {$24r, $24r$1, $24r$2, $24r$3, T, V, _1, _i, _r, _r$1, _r$2, _r$3, _r$4, _r$5, _r$6, _r$7, _r$8, _ref, _v, _v$1, _v$2, _v$3, cmpTags, i, i$1, i$2, kind, t, t$1, t$2, tf, v, v$1, v$2, vf, x, x$1, $s, $r, $c} = $restore(this, {T, V, cmpTags});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		if (T === V) {
			$s = -1; return true;
		}
		kind = T.Kind();
		if (!((kind === V.Kind()))) {
			$s = -1; return false;
		}
		if (1 <= kind && kind <= 16 || (kind === 24) || (kind === 26)) {
			$s = -1; return true;
		}
			_1 = kind;
			/* */ if (_1 === (17)) { $s = 2; continue; }
			/* */ if (_1 === (18)) { $s = 3; continue; }
			/* */ if (_1 === (19)) { $s = 4; continue; }
			/* */ if (_1 === (20)) { $s = 5; continue; }
			/* */ if (_1 === (21)) { $s = 6; continue; }
			/* */ if ((_1 === (22)) || (_1 === (23))) { $s = 7; continue; }
			/* */ if (_1 === (25)) { $s = 8; continue; }
			/* */ $s = 9; continue;
			/* if (_1 === (17)) { */ case 2:
				if (!(T.Len() === V.Len())) { _v = false; $s = 10; continue s; }
				_r = haveIdenticalType(T.Elem(), V.Elem(), cmpTags); /* */ $s = 11; case 11: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
				_v = _r; case 10:
				$24r = _v;
				$s = 12; case 12: return $24r;
			/* } else if (_1 === (18)) { */ case 3:
				if (!(V.chanDir() === 3)) { _v$1 = false; $s = 15; continue s; }
				_r$1 = haveIdenticalType(T.Elem(), V.Elem(), cmpTags); /* */ $s = 16; case 16: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
				_v$1 = _r$1; case 15:
				/* */ if (_v$1) { $s = 13; continue; }
				/* */ $s = 14; continue;
				/* if (_v$1) { */ case 13:
					$s = -1; return true;
				/* } */ case 14:
				if (!(V.chanDir() === T.chanDir())) { _v$2 = false; $s = 17; continue s; }
				_r$2 = haveIdenticalType(T.Elem(), V.Elem(), cmpTags); /* */ $s = 18; case 18: if($c) { $c = false; _r$2 = _r$2.$blk(); } if (_r$2 && _r$2.$blk !== undefined) { break s; }
				_v$2 = _r$2; case 17:
				$24r$1 = _v$2;
				$s = 19; case 19: return $24r$1;
			/* } else if (_1 === (19)) { */ case 4:
				t = (T.kindType);
				v = (V.kindType);
				if (!((t.outCount === v.outCount)) || !((t.inCount === v.inCount))) {
					$s = -1; return false;
				}
				i = 0;
				/* while (true) { */ case 20:
					/* if (!(i < t.rtype.NumIn())) { break; } */ if(!(i < t.rtype.NumIn())) { $s = 21; continue; }
					_r$3 = haveIdenticalType(t.rtype.In(i), v.rtype.In(i), cmpTags); /* */ $s = 24; case 24: if($c) { $c = false; _r$3 = _r$3.$blk(); } if (_r$3 && _r$3.$blk !== undefined) { break s; }
					/* */ if (!_r$3) { $s = 22; continue; }
					/* */ $s = 23; continue;
					/* if (!_r$3) { */ case 22:
						$s = -1; return false;
					/* } */ case 23:
					i = i + (1) >> 0;
				$s = 20; continue;
				case 21:
				i$1 = 0;
				/* while (true) { */ case 25:
					/* if (!(i$1 < t.rtype.NumOut())) { break; } */ if(!(i$1 < t.rtype.NumOut())) { $s = 26; continue; }
					_r$4 = haveIdenticalType(t.rtype.Out(i$1), v.rtype.Out(i$1), cmpTags); /* */ $s = 29; case 29: if($c) { $c = false; _r$4 = _r$4.$blk(); } if (_r$4 && _r$4.$blk !== undefined) { break s; }
					/* */ if (!_r$4) { $s = 27; continue; }
					/* */ $s = 28; continue;
					/* if (!_r$4) { */ case 27:
						$s = -1; return false;
					/* } */ case 28:
					i$1 = i$1 + (1) >> 0;
				$s = 25; continue;
				case 26:
				$s = -1; return true;
			/* } else if (_1 === (20)) { */ case 5:
				t$1 = (T.kindType);
				v$1 = (V.kindType);
				if ((t$1.methods.$length === 0) && (v$1.methods.$length === 0)) {
					$s = -1; return true;
				}
				$s = -1; return false;
			/* } else if (_1 === (21)) { */ case 6:
				_r$5 = haveIdenticalType(T.Key(), V.Key(), cmpTags); /* */ $s = 31; case 31: if($c) { $c = false; _r$5 = _r$5.$blk(); } if (_r$5 && _r$5.$blk !== undefined) { break s; }
				if (!(_r$5)) { _v$3 = false; $s = 30; continue s; }
				_r$6 = haveIdenticalType(T.Elem(), V.Elem(), cmpTags); /* */ $s = 32; case 32: if($c) { $c = false; _r$6 = _r$6.$blk(); } if (_r$6 && _r$6.$blk !== undefined) { break s; }
				_v$3 = _r$6; case 30:
				$24r$2 = _v$3;
				$s = 33; case 33: return $24r$2;
			/* } else if ((_1 === (22)) || (_1 === (23))) { */ case 7:
				_r$7 = haveIdenticalType(T.Elem(), V.Elem(), cmpTags); /* */ $s = 34; case 34: if($c) { $c = false; _r$7 = _r$7.$blk(); } if (_r$7 && _r$7.$blk !== undefined) { break s; }
				$24r$3 = _r$7;
				$s = 35; case 35: return $24r$3;
			/* } else if (_1 === (25)) { */ case 8:
				t$2 = (T.kindType);
				v$2 = (V.kindType);
				if (!((t$2.fields.$length === v$2.fields.$length))) {
					$s = -1; return false;
				}
				if (!($clone(t$2.pkgPath, name).name() === $clone(v$2.pkgPath, name).name())) {
					$s = -1; return false;
				}
				_ref = t$2.fields;
				_i = 0;
				/* while (true) { */ case 36:
					/* if (!(_i < _ref.$length)) { break; } */ if(!(_i < _ref.$length)) { $s = 37; continue; }
					i$2 = _i;
					tf = (x = t$2.fields, ((i$2 < 0 || i$2 >= x.$length) ? ($throwRuntimeError("index out of range"), undefined) : x.$array[x.$offset + i$2]));
					vf = (x$1 = v$2.fields, ((i$2 < 0 || i$2 >= x$1.$length) ? ($throwRuntimeError("index out of range"), undefined) : x$1.$array[x$1.$offset + i$2]));
					if (!($clone(tf.name, name).name() === $clone(vf.name, name).name())) {
						$s = -1; return false;
					}
					_r$8 = haveIdenticalType(tf.typ, vf.typ, cmpTags); /* */ $s = 40; case 40: if($c) { $c = false; _r$8 = _r$8.$blk(); } if (_r$8 && _r$8.$blk !== undefined) { break s; }
					/* */ if (!_r$8) { $s = 38; continue; }
					/* */ $s = 39; continue;
					/* if (!_r$8) { */ case 38:
						$s = -1; return false;
					/* } */ case 39:
					if (cmpTags && !($clone(tf.name, name).tag() === $clone(vf.name, name).tag())) {
						$s = -1; return false;
					}
					if (!((tf.offset === vf.offset))) {
						$s = -1; return false;
					}
					if (!(tf.embedded() === vf.embedded())) {
						$s = -1; return false;
					}
					_i++;
				$s = 36; continue;
				case 37:
				$s = -1; return true;
			/* } */ case 9:
		case 1:
		$s = -1; return false;
		/* */ } return; } var $f = {$blk: haveIdenticalUnderlyingType, $c: true, $r, $24r, $24r$1, $24r$2, $24r$3, T, V, _1, _i, _r, _r$1, _r$2, _r$3, _r$4, _r$5, _r$6, _r$7, _r$8, _ref, _v, _v$1, _v$2, _v$3, cmpTags, i, i$1, i$2, kind, t, t$1, t$2, tf, v, v$1, v$2, vf, x, x$1, $s};return $f;
	};
	toType = function(t) {
		var t;
		if (t === ptrType$1.nil) {
			return $ifaceNil;
		}
		return t;
	};
	ifaceIndir = function(t) {
		var t;
		return ((t.kind & 32) >>> 0) === 0;
	};
	Value.ptr.prototype.object = function() {
		var _1, newVal, v, val;
		v = this;
		if ((v.typ.Kind() === 17) || (v.typ.Kind() === 25)) {
			return v.ptr;
		}
		if (!((((v.flag & 128) >>> 0) === 0))) {
			val = v.ptr.$get();
			if (!(val === $ifaceNil) && !(val.constructor === jsType(v.typ))) {
				switch (0) { default:
					_1 = v.typ.Kind();
					if ((_1 === (11)) || (_1 === (6))) {
						val = new (jsType(v.typ))(val.$high, val.$low);
					} else if ((_1 === (15)) || (_1 === (16))) {
						val = new (jsType(v.typ))(val.$real, val.$imag);
					} else if (_1 === (23)) {
						if (val === val.constructor.nil) {
							val = jsType(v.typ).nil;
							break;
						}
						newVal = new (jsType(v.typ))(val.$array);
						newVal.$offset = val.$offset;
						newVal.$length = val.$length;
						newVal.$capacity = val.$capacity;
						val = newVal;
					}
				}
			}
			return val;
		}
		return v.ptr;
	};
	Value.prototype.object = function() { return this.$val.object(); };
	Value.ptr.prototype.assignTo = function(context, dst, target) {
		var {_r, _r$1, _r$2, context, dst, fl, target, v, x, $s, $r, $c} = $restore(this, {context, dst, target});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		v = this;
		/* */ if (!((((v.flag & 512) >>> 0) === 0))) { $s = 1; continue; }
		/* */ $s = 2; continue;
		/* if (!((((v.flag & 512) >>> 0) === 0))) { */ case 1:
			_r = makeMethodValue(context, $clone(v, Value)); /* */ $s = 3; case 3: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
			Value.copy(v, _r);
		/* } */ case 2:
			_r$1 = directlyAssignable(dst, v.typ); /* */ $s = 8; case 8: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
			/* */ if (_r$1) { $s = 5; continue; }
			/* */ if (implements$1(dst, v.typ)) { $s = 6; continue; }
			/* */ $s = 7; continue;
			/* if (_r$1) { */ case 5:
				fl = (((v.flag & 384) >>> 0) | new flag(v.flag).ro()) >>> 0;
				fl = (fl | (((dst.Kind() >>> 0)))) >>> 0;
				$s = -1; return new Value.ptr(dst, v.ptr, fl);
			/* } else if (implements$1(dst, v.typ)) { */ case 6:
				if (target === 0) {
					target = unsafe_New(dst);
				}
				_r$2 = valueInterface($clone(v, Value)); /* */ $s = 9; case 9: if($c) { $c = false; _r$2 = _r$2.$blk(); } if (_r$2 && _r$2.$blk !== undefined) { break s; }
				x = _r$2;
				if (dst.NumMethod() === 0) {
					(target).$set(x);
				} else {
					ifaceE2I(dst, x, target);
				}
				$s = -1; return new Value.ptr(dst, target, 148);
			/* } */ case 7:
		case 4:
		$panic(new $String(context + ": value of type " + v.typ.String() + " is not assignable to type " + dst.String()));
		$s = -1; return new Value.ptr(ptrType$1.nil, 0, 0);
		/* */ } return; } var $f = {$blk: Value.ptr.prototype.assignTo, $c: true, $r, _r, _r$1, _r$2, context, dst, fl, target, v, x, $s};return $f;
	};
	Value.prototype.assignTo = function(context, dst, target) { return this.$val.assignTo(context, dst, target); };
	Value.ptr.prototype.Cap = function() {
		var _1, k, v;
		v = this;
		k = new flag(v.flag).kind();
		_1 = k;
		if (_1 === (17)) {
			return v.typ.Len();
		} else if ((_1 === (18)) || (_1 === (23))) {
			return $parseInt($clone(v, Value).object().$capacity) >> 0;
		}
		$panic(new ValueError.ptr("reflect.Value.Cap", k));
	};
	Value.prototype.Cap = function() { return this.$val.Cap(); };
	Value.ptr.prototype.Index = function(i) {
		var {$24r, $24r$1, _1, _r, _r$1, a, a$1, c, fl, fl$1, fl$2, i, k, s, str, tt, tt$1, typ, typ$1, v, $s, $r, $c} = $restore(this, {i});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		a = [a];
		a$1 = [a$1];
		c = [c];
		i = [i];
		typ = [typ];
		typ$1 = [typ$1];
		v = this;
			k = new flag(v.flag).kind();
			_1 = k;
			/* */ if (_1 === (17)) { $s = 2; continue; }
			/* */ if (_1 === (23)) { $s = 3; continue; }
			/* */ if (_1 === (24)) { $s = 4; continue; }
			/* */ $s = 5; continue;
			/* if (_1 === (17)) { */ case 2:
				tt = (v.typ.kindType);
				if (i[0] < 0 || i[0] > ((tt.len >> 0))) {
					$panic(new $String("reflect: array index out of range"));
				}
				typ[0] = tt.elem;
				fl = (((((v.flag & 384) >>> 0) | new flag(v.flag).ro()) >>> 0) | ((typ[0].Kind() >>> 0))) >>> 0;
				a[0] = v.ptr;
				/* */ if (!((((fl & 128) >>> 0) === 0)) && !((typ[0].Kind() === 17)) && !((typ[0].Kind() === 25))) { $s = 7; continue; }
				/* */ $s = 8; continue;
				/* if (!((((fl & 128) >>> 0) === 0)) && !((typ[0].Kind() === 17)) && !((typ[0].Kind() === 25))) { */ case 7:
					$s = -1; return new Value.ptr(typ[0], (new (jsType(PtrTo(typ[0])))((function(a, a$1, c, i, typ, typ$1) { return function() {
						return wrapJsObject(typ[0], a[0][i[0]]);
					}; })(a, a$1, c, i, typ, typ$1), (function(a, a$1, c, i, typ, typ$1) { return function(x) {
						var x;
						a[0][i[0]] = unwrapJsObject(typ[0], x);
					}; })(a, a$1, c, i, typ, typ$1))), fl);
				/* } */ case 8:
				_r = makeValue(typ[0], wrapJsObject(typ[0], a[0][i[0]]), fl); /* */ $s = 9; case 9: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
				$24r = _r;
				$s = 10; case 10: return $24r;
			/* } else if (_1 === (23)) { */ case 3:
				s = $clone(v, Value).object();
				if (i[0] < 0 || i[0] >= ($parseInt(s.$length) >> 0)) {
					$panic(new $String("reflect: slice index out of range"));
				}
				tt$1 = (v.typ.kindType);
				typ$1[0] = tt$1.elem;
				fl$1 = (((384 | new flag(v.flag).ro()) >>> 0) | ((typ$1[0].Kind() >>> 0))) >>> 0;
				i[0] = i[0] + (($parseInt(s.$offset) >> 0)) >> 0;
				a$1[0] = s.$array;
				/* */ if (!((((fl$1 & 128) >>> 0) === 0)) && !((typ$1[0].Kind() === 17)) && !((typ$1[0].Kind() === 25))) { $s = 11; continue; }
				/* */ $s = 12; continue;
				/* if (!((((fl$1 & 128) >>> 0) === 0)) && !((typ$1[0].Kind() === 17)) && !((typ$1[0].Kind() === 25))) { */ case 11:
					$s = -1; return new Value.ptr(typ$1[0], (new (jsType(PtrTo(typ$1[0])))((function(a, a$1, c, i, typ, typ$1) { return function() {
						return wrapJsObject(typ$1[0], a$1[0][i[0]]);
					}; })(a, a$1, c, i, typ, typ$1), (function(a, a$1, c, i, typ, typ$1) { return function(x) {
						var x;
						a$1[0][i[0]] = unwrapJsObject(typ$1[0], x);
					}; })(a, a$1, c, i, typ, typ$1))), fl$1);
				/* } */ case 12:
				_r$1 = makeValue(typ$1[0], wrapJsObject(typ$1[0], a$1[0][i[0]]), fl$1); /* */ $s = 13; case 13: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
				$24r$1 = _r$1;
				$s = 14; case 14: return $24r$1;
			/* } else if (_1 === (24)) { */ case 4:
				str = (v.ptr).$get();
				if (i[0] < 0 || i[0] >= str.length) {
					$panic(new $String("reflect: string index out of range"));
				}
				fl$2 = (((new flag(v.flag).ro() | 8) >>> 0) | 128) >>> 0;
				c[0] = str.charCodeAt(i[0]);
				$s = -1; return new Value.ptr(uint8Type, ((c.$ptr || (c.$ptr = new ptrType$6(function() { return this.$target[0]; }, function($v) { this.$target[0] = $v; }, c)))), fl$2);
			/* } else { */ case 5:
				$panic(new ValueError.ptr("reflect.Value.Index", k));
			/* } */ case 6:
		case 1:
		$s = -1; return new Value.ptr(ptrType$1.nil, 0, 0);
		/* */ } return; } var $f = {$blk: Value.ptr.prototype.Index, $c: true, $r, $24r, $24r$1, _1, _r, _r$1, a, a$1, c, fl, fl$1, fl$2, i, k, s, str, tt, tt$1, typ, typ$1, v, $s};return $f;
	};
	Value.prototype.Index = function(i) { return this.$val.Index(i); };
	Value.ptr.prototype.InterfaceData = function() {
		var v;
		v = this;
		$panic(new $String("InterfaceData is not supported by GopherJS"));
	};
	Value.prototype.InterfaceData = function() { return this.$val.InterfaceData(); };
	Value.ptr.prototype.IsNil = function() {
		var _1, k, v;
		v = this;
		k = new flag(v.flag).kind();
		_1 = k;
		if ((_1 === (22)) || (_1 === (23))) {
			return $clone(v, Value).object() === jsType(v.typ).nil;
		} else if (_1 === (18)) {
			return $clone(v, Value).object() === $chanNil;
		} else if (_1 === (19)) {
			return $clone(v, Value).object() === $throwNilPointerError;
		} else if (_1 === (21)) {
			return $clone(v, Value).object() === false;
		} else if (_1 === (20)) {
			return $clone(v, Value).object() === $ifaceNil;
		} else if (_1 === (26)) {
			return $clone(v, Value).object() === 0;
		} else {
			$panic(new ValueError.ptr("reflect.Value.IsNil", k));
		}
	};
	Value.prototype.IsNil = function() { return this.$val.IsNil(); };
	Value.ptr.prototype.Len = function() {
		var _1, k, v;
		v = this;
		k = new flag(v.flag).kind();
		_1 = k;
		if ((_1 === (17)) || (_1 === (24))) {
			return $parseInt($clone(v, Value).object().length);
		} else if (_1 === (23)) {
			return $parseInt($clone(v, Value).object().$length) >> 0;
		} else if (_1 === (18)) {
			return $parseInt($clone(v, Value).object().$buffer.length) >> 0;
		} else if (_1 === (21)) {
			return $parseInt($clone(v, Value).object().size) >> 0;
		} else {
			$panic(new ValueError.ptr("reflect.Value.Len", k));
		}
	};
	Value.prototype.Len = function() { return this.$val.Len(); };
	Value.ptr.prototype.Pointer = function() {
		var _1, k, v;
		v = this;
		k = new flag(v.flag).kind();
		_1 = k;
		if ((_1 === (18)) || (_1 === (21)) || (_1 === (22)) || (_1 === (26))) {
			if ($clone(v, Value).IsNil()) {
				return 0;
			}
			return $clone(v, Value).object();
		} else if (_1 === (19)) {
			if ($clone(v, Value).IsNil()) {
				return 0;
			}
			return 1;
		} else if (_1 === (23)) {
			if ($clone(v, Value).IsNil()) {
				return 0;
			}
			return $clone(v, Value).object().$array;
		} else {
			$panic(new ValueError.ptr("reflect.Value.Pointer", k));
		}
	};
	Value.prototype.Pointer = function() { return this.$val.Pointer(); };
	Value.ptr.prototype.Set = function(x) {
		var {_1, _r, _r$1, v, x, $s, $r, $c} = $restore(this, {x});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		v = this;
		new flag(v.flag).mustBeAssignable();
		new flag(x.flag).mustBeExported();
		_r = $clone(x, Value).assignTo("reflect.Set", v.typ, 0); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		Value.copy(x, _r);
		/* */ if (!((((v.flag & 128) >>> 0) === 0))) { $s = 2; continue; }
		/* */ $s = 3; continue;
		/* if (!((((v.flag & 128) >>> 0) === 0))) { */ case 2:
				_1 = v.typ.Kind();
				/* */ if (_1 === (17)) { $s = 5; continue; }
				/* */ if (_1 === (20)) { $s = 6; continue; }
				/* */ if (_1 === (25)) { $s = 7; continue; }
				/* */ $s = 8; continue;
				/* if (_1 === (17)) { */ case 5:
					jsType(v.typ).copy(v.ptr, x.ptr);
					$s = 9; continue;
				/* } else if (_1 === (20)) { */ case 6:
					_r$1 = valueInterface($clone(x, Value)); /* */ $s = 10; case 10: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
					v.ptr.$set(_r$1);
					$s = 9; continue;
				/* } else if (_1 === (25)) { */ case 7:
					copyStruct(v.ptr, x.ptr, v.typ);
					$s = 9; continue;
				/* } else { */ case 8:
					v.ptr.$set($clone(x, Value).object());
				/* } */ case 9:
			case 4:
			$s = -1; return;
		/* } */ case 3:
		v.ptr = x.ptr;
		$s = -1; return;
		/* */ } return; } var $f = {$blk: Value.ptr.prototype.Set, $c: true, $r, _1, _r, _r$1, v, x, $s};return $f;
	};
	Value.prototype.Set = function(x) { return this.$val.Set(x); };
	Value.ptr.prototype.SetBytes = function(x) {
		var {_r, _r$1, _v, slice, typedSlice, v, x, $s, $r, $c} = $restore(this, {x});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		v = this;
		new flag(v.flag).mustBeAssignable();
		new flag(v.flag).mustBe(23);
		_r = v.typ.Elem().Kind(); /* */ $s = 3; case 3: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		/* */ if (!((_r === 8))) { $s = 1; continue; }
		/* */ $s = 2; continue;
		/* if (!((_r === 8))) { */ case 1:
			$panic(new $String("reflect.Value.SetBytes of non-byte slice"));
		/* } */ case 2:
		slice = x;
		if (!(v.typ.Name() === "")) { _v = true; $s = 6; continue s; }
		_r$1 = v.typ.Elem().Name(); /* */ $s = 7; case 7: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
		_v = !(_r$1 === ""); case 6:
		/* */ if (_v) { $s = 4; continue; }
		/* */ $s = 5; continue;
		/* if (_v) { */ case 4:
			typedSlice = new (jsType(v.typ))(slice.$array);
			typedSlice.$offset = slice.$offset;
			typedSlice.$length = slice.$length;
			typedSlice.$capacity = slice.$capacity;
			slice = typedSlice;
		/* } */ case 5:
		v.ptr.$set(slice);
		$s = -1; return;
		/* */ } return; } var $f = {$blk: Value.ptr.prototype.SetBytes, $c: true, $r, _r, _r$1, _v, slice, typedSlice, v, x, $s};return $f;
	};
	Value.prototype.SetBytes = function(x) { return this.$val.SetBytes(x); };
	Value.ptr.prototype.SetCap = function(n) {
		var n, newSlice, s, v;
		v = this;
		new flag(v.flag).mustBeAssignable();
		new flag(v.flag).mustBe(23);
		s = v.ptr.$get();
		if (n < ($parseInt(s.$length) >> 0) || n > ($parseInt(s.$capacity) >> 0)) {
			$panic(new $String("reflect: slice capacity out of range in SetCap"));
		}
		newSlice = new (jsType(v.typ))(s.$array);
		newSlice.$offset = s.$offset;
		newSlice.$length = s.$length;
		newSlice.$capacity = n;
		v.ptr.$set(newSlice);
	};
	Value.prototype.SetCap = function(n) { return this.$val.SetCap(n); };
	Value.ptr.prototype.SetLen = function(n) {
		var n, newSlice, s, v;
		v = this;
		new flag(v.flag).mustBeAssignable();
		new flag(v.flag).mustBe(23);
		s = v.ptr.$get();
		if (n < 0 || n > ($parseInt(s.$capacity) >> 0)) {
			$panic(new $String("reflect: slice length out of range in SetLen"));
		}
		newSlice = new (jsType(v.typ))(s.$array);
		newSlice.$offset = s.$offset;
		newSlice.$length = n;
		newSlice.$capacity = s.$capacity;
		v.ptr.$set(newSlice);
	};
	Value.prototype.SetLen = function(n) { return this.$val.SetLen(n); };
	Value.ptr.prototype.Slice = function(i, j) {
		var {$24r, $24r$1, _1, _r, _r$1, cap, i, j, kind, s, str, tt, typ, v, $s, $r, $c} = $restore(this, {i, j});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		v = this;
		cap = 0;
		typ = $ifaceNil;
		s = null;
			kind = new flag(v.flag).kind();
			_1 = kind;
			/* */ if (_1 === (17)) { $s = 2; continue; }
			/* */ if (_1 === (23)) { $s = 3; continue; }
			/* */ if (_1 === (24)) { $s = 4; continue; }
			/* */ $s = 5; continue;
			/* if (_1 === (17)) { */ case 2:
				if (((v.flag & 256) >>> 0) === 0) {
					$panic(new $String("reflect.Value.Slice: slice of unaddressable array"));
				}
				tt = (v.typ.kindType);
				cap = ((tt.len >> 0));
				typ = SliceOf(tt.elem);
				s = new (jsType(typ))($clone(v, Value).object());
				$s = 6; continue;
			/* } else if (_1 === (23)) { */ case 3:
				typ = v.typ;
				s = $clone(v, Value).object();
				cap = $parseInt(s.$capacity) >> 0;
				$s = 6; continue;
			/* } else if (_1 === (24)) { */ case 4:
				str = (v.ptr).$get();
				if (i < 0 || j < i || j > str.length) {
					$panic(new $String("reflect.Value.Slice: string slice index out of bounds"));
				}
				_r = ValueOf(new $String($substring(str, i, j))); /* */ $s = 7; case 7: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
				$24r = _r;
				$s = 8; case 8: return $24r;
			/* } else { */ case 5:
				$panic(new ValueError.ptr("reflect.Value.Slice", kind));
			/* } */ case 6:
		case 1:
		if (i < 0 || j < i || j > cap) {
			$panic(new $String("reflect.Value.Slice: slice index out of bounds"));
		}
		_r$1 = makeValue(typ, $subslice(s, i, j), new flag(v.flag).ro()); /* */ $s = 9; case 9: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
		$24r$1 = _r$1;
		$s = 10; case 10: return $24r$1;
		/* */ } return; } var $f = {$blk: Value.ptr.prototype.Slice, $c: true, $r, $24r, $24r$1, _1, _r, _r$1, cap, i, j, kind, s, str, tt, typ, v, $s};return $f;
	};
	Value.prototype.Slice = function(i, j) { return this.$val.Slice(i, j); };
	Value.ptr.prototype.Slice3 = function(i, j, k) {
		var {$24r, _1, _r, cap, i, j, k, kind, s, tt, typ, v, $s, $r, $c} = $restore(this, {i, j, k});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		v = this;
		cap = 0;
		typ = $ifaceNil;
		s = null;
		kind = new flag(v.flag).kind();
		_1 = kind;
		if (_1 === (17)) {
			if (((v.flag & 256) >>> 0) === 0) {
				$panic(new $String("reflect.Value.Slice: slice of unaddressable array"));
			}
			tt = (v.typ.kindType);
			cap = ((tt.len >> 0));
			typ = SliceOf(tt.elem);
			s = new (jsType(typ))($clone(v, Value).object());
		} else if (_1 === (23)) {
			typ = v.typ;
			s = $clone(v, Value).object();
			cap = $parseInt(s.$capacity) >> 0;
		} else {
			$panic(new ValueError.ptr("reflect.Value.Slice3", kind));
		}
		if (i < 0 || j < i || k < j || k > cap) {
			$panic(new $String("reflect.Value.Slice3: slice index out of bounds"));
		}
		_r = makeValue(typ, $subslice(s, i, j, k), new flag(v.flag).ro()); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		$24r = _r;
		$s = 2; case 2: return $24r;
		/* */ } return; } var $f = {$blk: Value.ptr.prototype.Slice3, $c: true, $r, $24r, _1, _r, cap, i, j, k, kind, s, tt, typ, v, $s};return $f;
	};
	Value.prototype.Slice3 = function(i, j, k) { return this.$val.Slice3(i, j, k); };
	Value.ptr.prototype.Close = function() {
		var v;
		v = this;
		new flag(v.flag).mustBe(18);
		new flag(v.flag).mustBeExported();
		$close($clone(v, Value).object());
	};
	Value.prototype.Close = function() { return this.$val.Close(); };
	Value.ptr.prototype.Elem = function() {
		var {$24r, _1, _r, fl, k, tt, typ, v, val, val$1, $s, $r, $c} = $restore(this, {});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		v = this;
			k = new flag(v.flag).kind();
			_1 = k;
			/* */ if (_1 === (20)) { $s = 2; continue; }
			/* */ if (_1 === (22)) { $s = 3; continue; }
			/* */ $s = 4; continue;
			/* if (_1 === (20)) { */ case 2:
				val = $clone(v, Value).object();
				if (val === $ifaceNil) {
					$s = -1; return new Value.ptr(ptrType$1.nil, 0, 0);
				}
				typ = reflectType(val.constructor);
				_r = makeValue(typ, val.$val, new flag(v.flag).ro()); /* */ $s = 6; case 6: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
				$24r = _r;
				$s = 7; case 7: return $24r;
			/* } else if (_1 === (22)) { */ case 3:
				if ($clone(v, Value).IsNil()) {
					$s = -1; return new Value.ptr(ptrType$1.nil, 0, 0);
				}
				val$1 = $clone(v, Value).object();
				tt = (v.typ.kindType);
				fl = (((((v.flag & 96) >>> 0) | 128) >>> 0) | 256) >>> 0;
				fl = (fl | (((tt.elem.Kind() >>> 0)))) >>> 0;
				$s = -1; return new Value.ptr(tt.elem, (wrapJsObject(tt.elem, val$1)), fl);
			/* } else { */ case 4:
				$panic(new ValueError.ptr("reflect.Value.Elem", k));
			/* } */ case 5:
		case 1:
		$s = -1; return new Value.ptr(ptrType$1.nil, 0, 0);
		/* */ } return; } var $f = {$blk: Value.ptr.prototype.Elem, $c: true, $r, $24r, _1, _r, fl, k, tt, typ, v, val, val$1, $s};return $f;
	};
	Value.prototype.Elem = function() { return this.$val.Elem(); };
	Value.ptr.prototype.NumField = function() {
		var tt, v;
		v = this;
		new flag(v.flag).mustBe(25);
		tt = (v.typ.kindType);
		return tt.fields.$length;
	};
	Value.prototype.NumField = function() { return this.$val.NumField(); };
	Value.ptr.prototype.MapKeys = function() {
		var {_r, a, fl, i, it, key, keyType, m, mlen, tt, v, $s, $r, $c} = $restore(this, {});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		v = this;
		new flag(v.flag).mustBe(21);
		tt = (v.typ.kindType);
		keyType = tt.key;
		fl = (new flag(v.flag).ro() | ((keyType.Kind() >>> 0))) >>> 0;
		m = $clone(v, Value).pointer();
		mlen = 0;
		if (!(m === 0)) {
			mlen = maplen(m);
		}
		it = mapiterinit(v.typ, m);
		a = $makeSlice(sliceType$6, mlen);
		i = 0;
		i = 0;
		/* while (true) { */ case 1:
			/* if (!(i < a.$length)) { break; } */ if(!(i < a.$length)) { $s = 2; continue; }
			_r = mapiterkey(it); /* */ $s = 3; case 3: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
			key = _r;
			if (key === 0) {
				/* break; */ $s = 2; continue;
			}
			Value.copy(((i < 0 || i >= a.$length) ? ($throwRuntimeError("index out of range"), undefined) : a.$array[a.$offset + i]), copyVal(keyType, fl, key));
			mapiternext(it);
			i = i + (1) >> 0;
		$s = 1; continue;
		case 2:
		$s = -1; return $subslice(a, 0, i);
		/* */ } return; } var $f = {$blk: Value.ptr.prototype.MapKeys, $c: true, $r, _r, a, fl, i, it, key, keyType, m, mlen, tt, v, $s};return $f;
	};
	Value.prototype.MapKeys = function() { return this.$val.MapKeys(); };
	Value.ptr.prototype.MapIndex = function(key) {
		var {_r, e, fl, k, key, tt, typ, v, $s, $r, $c} = $restore(this, {key});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		v = this;
		new flag(v.flag).mustBe(21);
		tt = (v.typ.kindType);
		_r = $clone(key, Value).assignTo("reflect.Value.MapIndex", tt.key, 0); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		Value.copy(key, _r);
		k = 0;
		if (!((((key.flag & 128) >>> 0) === 0))) {
			k = key.ptr;
		} else {
			k = ((key.$ptr_ptr || (key.$ptr_ptr = new ptrType$7(function() { return this.$target.ptr; }, function($v) { this.$target.ptr = $v; }, key))));
		}
		e = mapaccess(v.typ, $clone(v, Value).pointer(), k);
		if (e === 0) {
			$s = -1; return new Value.ptr(ptrType$1.nil, 0, 0);
		}
		typ = tt.elem;
		fl = new flag((((v.flag | key.flag) >>> 0))).ro();
		fl = (fl | (((typ.Kind() >>> 0)))) >>> 0;
		$s = -1; return copyVal(typ, fl, e);
		/* */ } return; } var $f = {$blk: Value.ptr.prototype.MapIndex, $c: true, $r, _r, e, fl, k, key, tt, typ, v, $s};return $f;
	};
	Value.prototype.MapIndex = function(key) { return this.$val.MapIndex(key); };
	Value.ptr.prototype.Field = function(i) {
		var {$24r, _r, _r$1, _r$2, field, fl, i, jsTag, o, prop, s, tag, tt, typ, v, x, x$1, $s, $r, $c} = $restore(this, {i});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		jsTag = [jsTag];
		prop = [prop];
		s = [s];
		typ = [typ];
		v = this;
		if (!((new flag(v.flag).kind() === 25))) {
			$panic(new ValueError.ptr("reflect.Value.Field", new flag(v.flag).kind()));
		}
		tt = (v.typ.kindType);
		if (((i >>> 0)) >= ((tt.fields.$length >>> 0))) {
			$panic(new $String("reflect: Field index out of range"));
		}
		prop[0] = $internalize(jsType(v.typ).fields[i].prop, $String);
		field = (x = tt.fields, ((i < 0 || i >= x.$length) ? ($throwRuntimeError("index out of range"), undefined) : x.$array[x.$offset + i]));
		typ[0] = field.typ;
		fl = (((v.flag & 416) >>> 0) | ((typ[0].Kind() >>> 0))) >>> 0;
		if (!$clone(field.name, name).isExported()) {
			if (field.embedded()) {
				fl = (fl | (64)) >>> 0;
			} else {
				fl = (fl | (32)) >>> 0;
			}
		}
		tag = $clone((x$1 = tt.fields, ((i < 0 || i >= x$1.$length) ? ($throwRuntimeError("index out of range"), undefined) : x$1.$array[x$1.$offset + i])).name, name).tag();
		/* */ if (!(tag === "") && !((i === 0))) { $s = 1; continue; }
		/* */ $s = 2; continue;
		/* if (!(tag === "") && !((i === 0))) { */ case 1:
			jsTag[0] = getJsTag(tag);
			/* */ if (!(jsTag[0] === "")) { $s = 3; continue; }
			/* */ $s = 4; continue;
			/* if (!(jsTag[0] === "")) { */ case 3:
				/* while (true) { */ case 5:
					o = [o];
					_r = $clone(v, Value).Field(0); /* */ $s = 7; case 7: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
					Value.copy(v, _r);
					/* */ if (v.typ === jsObjectPtr) { $s = 8; continue; }
					/* */ $s = 9; continue;
					/* if (v.typ === jsObjectPtr) { */ case 8:
						o[0] = $clone(v, Value).object().object;
						$s = -1; return new Value.ptr(typ[0], (new (jsType(PtrTo(typ[0])))((function(jsTag, o, prop, s, typ) { return function() {
							return $internalize(o[0][$externalize(jsTag[0], $String)], jsType(typ[0]));
						}; })(jsTag, o, prop, s, typ), (function(jsTag, o, prop, s, typ) { return function(x$2) {
							var x$2;
							o[0][$externalize(jsTag[0], $String)] = $externalize(x$2, jsType(typ[0]));
						}; })(jsTag, o, prop, s, typ))), fl);
					/* } */ case 9:
					/* */ if (v.typ.Kind() === 22) { $s = 10; continue; }
					/* */ $s = 11; continue;
					/* if (v.typ.Kind() === 22) { */ case 10:
						_r$1 = $clone(v, Value).Elem(); /* */ $s = 12; case 12: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
						Value.copy(v, _r$1);
					/* } */ case 11:
				$s = 5; continue;
				case 6:
			/* } */ case 4:
		/* } */ case 2:
		s[0] = v.ptr;
		/* */ if (!((((fl & 128) >>> 0) === 0)) && !((typ[0].Kind() === 17)) && !((typ[0].Kind() === 25))) { $s = 13; continue; }
		/* */ $s = 14; continue;
		/* if (!((((fl & 128) >>> 0) === 0)) && !((typ[0].Kind() === 17)) && !((typ[0].Kind() === 25))) { */ case 13:
			$s = -1; return new Value.ptr(typ[0], (new (jsType(PtrTo(typ[0])))((function(jsTag, prop, s, typ) { return function() {
				return wrapJsObject(typ[0], s[0][$externalize(prop[0], $String)]);
			}; })(jsTag, prop, s, typ), (function(jsTag, prop, s, typ) { return function(x$2) {
				var x$2;
				s[0][$externalize(prop[0], $String)] = unwrapJsObject(typ[0], x$2);
			}; })(jsTag, prop, s, typ))), fl);
		/* } */ case 14:
		_r$2 = makeValue(typ[0], wrapJsObject(typ[0], s[0][$externalize(prop[0], $String)]), fl); /* */ $s = 15; case 15: if($c) { $c = false; _r$2 = _r$2.$blk(); } if (_r$2 && _r$2.$blk !== undefined) { break s; }
		$24r = _r$2;
		$s = 16; case 16: return $24r;
		/* */ } return; } var $f = {$blk: Value.ptr.prototype.Field, $c: true, $r, $24r, _r, _r$1, _r$2, field, fl, i, jsTag, o, prop, s, tag, tt, typ, v, x, x$1, $s};return $f;
	};
	Value.prototype.Field = function(i) { return this.$val.Field(i); };
	errorString.ptr.prototype.Error = function() {
		var e;
		e = this;
		return e.s;
	};
	errorString.prototype.Error = function() { return this.$val.Error(); };
	unquote = function(s) {
		var s;
		if (s.length < 2) {
			return [s, $ifaceNil];
		}
		if ((s.charCodeAt(0) === 39) || (s.charCodeAt(0) === 34)) {
			if (s.charCodeAt((s.length - 1 >> 0)) === s.charCodeAt(0)) {
				return [$substring(s, 1, (s.length - 1 >> 0)), $ifaceNil];
			}
			return ["", $pkg.ErrSyntax];
		}
		return [s, $ifaceNil];
	};
	flag.prototype.mustBe = function(expected) {
		var expected, f;
		f = this.$val;
		if (!((((((f & 31) >>> 0) >>> 0)) === expected))) {
			$panic(new ValueError.ptr(methodName(), new flag(f).kind()));
		}
	};
	$ptrType(flag).prototype.mustBe = function(expected) { return new flag(this.$get()).mustBe(expected); };
	rtype.ptr.prototype.Comparable = function() {
		var {$24r, _1, _r, _r$1, ft, i, t, $s, $r, $c} = $restore(this, {});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		t = this;
			_1 = t.Kind();
			/* */ if ((_1 === (19)) || (_1 === (23)) || (_1 === (21))) { $s = 2; continue; }
			/* */ if (_1 === (17)) { $s = 3; continue; }
			/* */ if (_1 === (25)) { $s = 4; continue; }
			/* */ $s = 5; continue;
			/* if ((_1 === (19)) || (_1 === (23)) || (_1 === (21))) { */ case 2:
				$s = -1; return false;
			/* } else if (_1 === (17)) { */ case 3:
				_r = t.Elem().Comparable(); /* */ $s = 6; case 6: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
				$24r = _r;
				$s = 7; case 7: return $24r;
			/* } else if (_1 === (25)) { */ case 4:
				i = 0;
				/* while (true) { */ case 8:
					/* if (!(i < t.NumField())) { break; } */ if(!(i < t.NumField())) { $s = 9; continue; }
					ft = $clone(t.Field(i), structField);
					_r$1 = ft.typ.Comparable(); /* */ $s = 12; case 12: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
					/* */ if (!_r$1) { $s = 10; continue; }
					/* */ $s = 11; continue;
					/* if (!_r$1) { */ case 10:
						$s = -1; return false;
					/* } */ case 11:
					i = i + (1) >> 0;
				$s = 8; continue;
				case 9:
			/* } */ case 5:
		case 1:
		$s = -1; return true;
		/* */ } return; } var $f = {$blk: rtype.ptr.prototype.Comparable, $c: true, $r, $24r, _1, _r, _r$1, ft, i, t, $s};return $f;
	};
	rtype.prototype.Comparable = function() { return this.$val.Comparable(); };
	rtype.ptr.prototype.IsVariadic = function() {
		var t, tt;
		t = this;
		if (!((t.Kind() === 19))) {
			$panic(new $String("reflect: IsVariadic of non-func type"));
		}
		tt = (t.kindType);
		return !((((tt.outCount & 32768) >>> 0) === 0));
	};
	rtype.prototype.IsVariadic = function() { return this.$val.IsVariadic(); };
	rtype.ptr.prototype.Field = function(i) {
		var i, t, tt, x;
		t = this;
		if (!((t.Kind() === 25))) {
			$panic(new $String("reflect: Field of non-struct type"));
		}
		tt = (t.kindType);
		if (i < 0 || i >= tt.fields.$length) {
			$panic(new $String("reflect: Field index out of bounds"));
		}
		return (x = tt.fields, ((i < 0 || i >= x.$length) ? ($throwRuntimeError("index out of range"), undefined) : x.$array[x.$offset + i]));
	};
	rtype.prototype.Field = function(i) { return this.$val.Field(i); };
	rtype.ptr.prototype.Key = function() {
		var t, tt;
		t = this;
		if (!((t.Kind() === 21))) {
			$panic(new $String("reflect: Key of non-map type"));
		}
		tt = (t.kindType);
		return toType(tt.key);
	};
	rtype.prototype.Key = function() { return this.$val.Key(); };
	rtype.ptr.prototype.NumField = function() {
		var t, tt;
		t = this;
		if (!((t.Kind() === 25))) {
			$panic(new $String("reflect: NumField of non-struct type"));
		}
		tt = (t.kindType);
		return tt.fields.$length;
	};
	rtype.prototype.NumField = function() { return this.$val.NumField(); };
	rtype.ptr.prototype.Method = function(i) {
		var {$24r, _i, _i$1, _r, _r$1, _ref, _ref$1, arg, fl, fn, ft, i, in$1, m, methods, mt, mtyp, out, p, pname, prop, ret, t, tt, $s, $r, $c} = $restore(this, {i});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		prop = [prop];
		m = new Method.ptr("", "", $ifaceNil, new Value.ptr(ptrType$1.nil, 0, 0), 0);
		t = this;
		/* */ if (t.Kind() === 20) { $s = 1; continue; }
		/* */ $s = 2; continue;
		/* if (t.Kind() === 20) { */ case 1:
			tt = (t.kindType);
			_r = tt.rtype.Method(i); /* */ $s = 3; case 3: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
			Method.copy(m, _r);
			$24r = m;
			$s = 4; case 4: return $24r;
		/* } */ case 2:
		methods = t.exportedMethods();
		if (i < 0 || i >= methods.$length) {
			$panic(new $String("reflect: Method index out of range"));
		}
		p = $clone(((i < 0 || i >= methods.$length) ? ($throwRuntimeError("index out of range"), undefined) : methods.$array[methods.$offset + i]), method);
		pname = $clone(t.nameOff(p.name), name);
		m.Name = $clone(pname, name).name();
		fl = 19;
		mtyp = t.typeOff(p.mtyp);
		ft = (mtyp.kindType);
		in$1 = $makeSlice(sliceType$7, 0, (1 + ft.in$().$length >> 0));
		in$1 = $append(in$1, t);
		_ref = ft.in$();
		_i = 0;
		while (true) {
			if (!(_i < _ref.$length)) { break; }
			arg = ((_i < 0 || _i >= _ref.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref.$array[_ref.$offset + _i]);
			in$1 = $append(in$1, arg);
			_i++;
		}
		out = $makeSlice(sliceType$7, 0, ft.out().$length);
		_ref$1 = ft.out();
		_i$1 = 0;
		while (true) {
			if (!(_i$1 < _ref$1.$length)) { break; }
			ret = ((_i$1 < 0 || _i$1 >= _ref$1.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref$1.$array[_ref$1.$offset + _i$1]);
			out = $append(out, ret);
			_i$1++;
		}
		_r$1 = FuncOf(in$1, out, ft.rtype.IsVariadic()); /* */ $s = 5; case 5: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
		mt = _r$1;
		m.Type = mt;
		prop[0] = $internalize($methodSet(t[$externalize(idJsType, $String)])[i].prop, $String);
		fn = js.MakeFunc((function(prop) { return function(this$1, arguments$1) {
			var arguments$1, rcvr, this$1;
			rcvr = (0 >= arguments$1.$length ? ($throwRuntimeError("index out of range"), undefined) : arguments$1.$array[arguments$1.$offset + 0]);
			return new $jsObjectPtr(rcvr[$externalize(prop[0], $String)].apply(rcvr, $externalize($subslice(arguments$1, 1), sliceType$8)));
		}; })(prop));
		Value.copy(m.Func, new Value.ptr($assertType(mt, ptrType$1), (fn), fl));
		m.Index = i;
		Method.copy(m, m);
		$s = -1; return m;
		/* */ } return; } var $f = {$blk: rtype.ptr.prototype.Method, $c: true, $r, $24r, _i, _i$1, _r, _r$1, _ref, _ref$1, arg, fl, fn, ft, i, in$1, m, methods, mt, mtyp, out, p, pname, prop, ret, t, tt, $s};return $f;
	};
	rtype.prototype.Method = function(i) { return this.$val.Method(i); };
	init = function() {
		var {used, x, x$1, x$10, x$11, x$12, x$2, x$3, x$4, x$5, x$6, x$7, x$8, x$9, $s, $r, $c} = $restore(this, {});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		used = (function(i) {
			var i;
		});
		$r = used((x = new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$6.nil, 0, 0), new x.constructor.elem(x))); /* */ $s = 1; case 1: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = used((x$1 = new uncommonType.ptr(0, 0, 0, 0, sliceType$5.nil), new x$1.constructor.elem(x$1))); /* */ $s = 2; case 2: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = used((x$2 = new method.ptr(0, 0, 0, 0), new x$2.constructor.elem(x$2))); /* */ $s = 3; case 3: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = used((x$3 = new arrayType.ptr(new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$6.nil, 0, 0), ptrType$1.nil, ptrType$1.nil, 0), new x$3.constructor.elem(x$3))); /* */ $s = 4; case 4: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = used((x$4 = new chanType.ptr(new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$6.nil, 0, 0), ptrType$1.nil, 0), new x$4.constructor.elem(x$4))); /* */ $s = 5; case 5: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = used((x$5 = new funcType.ptr(new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$6.nil, 0, 0), 0, 0, sliceType$2.nil, sliceType$2.nil), new x$5.constructor.elem(x$5))); /* */ $s = 6; case 6: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = used((x$6 = new interfaceType.ptr(new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$6.nil, 0, 0), new name.ptr(ptrType$6.nil), sliceType$9.nil), new x$6.constructor.elem(x$6))); /* */ $s = 7; case 7: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = used((x$7 = new mapType.ptr(new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$6.nil, 0, 0), ptrType$1.nil, ptrType$1.nil, ptrType$1.nil, $throwNilPointerError, 0, 0, 0, 0), new x$7.constructor.elem(x$7))); /* */ $s = 8; case 8: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = used((x$8 = new ptrType.ptr(new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$6.nil, 0, 0), ptrType$1.nil), new x$8.constructor.elem(x$8))); /* */ $s = 9; case 9: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = used((x$9 = new sliceType.ptr(new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$6.nil, 0, 0), ptrType$1.nil), new x$9.constructor.elem(x$9))); /* */ $s = 10; case 10: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = used((x$10 = new structType.ptr(new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$6.nil, 0, 0), new name.ptr(ptrType$6.nil), sliceType$10.nil), new x$10.constructor.elem(x$10))); /* */ $s = 11; case 11: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = used((x$11 = new imethod.ptr(0, 0), new x$11.constructor.elem(x$11))); /* */ $s = 12; case 12: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = used((x$12 = new structField.ptr(new name.ptr(ptrType$6.nil), ptrType$1.nil, 0), new x$12.constructor.elem(x$12))); /* */ $s = 13; case 13: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		initialized = true;
		uint8Type = $assertType(TypeOf(new $Uint8(0)), ptrType$1);
		$s = -1; return;
		/* */ } return; } var $f = {$blk: init, $c: true, $r, used, x, x$1, x$10, x$11, x$12, x$2, x$3, x$4, x$5, x$6, x$7, x$8, x$9, $s};return $f;
	};
	jsType = function(typ) {
		var typ;
		return typ[$externalize(idJsType, $String)];
	};
	reflectType = function(typ) {
		var _1, _i, _i$1, _i$2, _i$3, _key, _ref, _ref$1, _ref$2, _ref$3, dir, exported, exported$1, f, fields, i, i$1, i$2, i$3, i$4, i$5, imethods, in$1, m, m$1, m$2, methodSet, methods, out, outCount, params, reflectFields, reflectMethods, results, rt, typ, ut, xcount;
		if (typ[$externalize(idReflectType, $String)] === undefined) {
			rt = new rtype.ptr(((($parseInt(typ.size) >> 0) >>> 0)), 0, 0, 0, 0, 0, ((($parseInt(typ.kind) >> 0) << 24 >>> 24)), $throwNilPointerError, ptrType$6.nil, newNameOff($clone(newName(internalStr(typ.string), "", !!(typ.exported), false), name)), 0);
			rt[$externalize(idJsType, $String)] = typ;
			typ[$externalize(idReflectType, $String)] = rt;
			methodSet = $methodSet(typ);
			if (!(($parseInt(methodSet.length) === 0)) || !!(typ.named)) {
				rt.tflag = (rt.tflag | (1)) >>> 0;
				if (!!(typ.named)) {
					rt.tflag = (rt.tflag | (4)) >>> 0;
				}
				reflectMethods = sliceType$5.nil;
				i = 0;
				while (true) {
					if (!(i < $parseInt(methodSet.length))) { break; }
					m = methodSet[i];
					exported = internalStr(m.pkg) === "";
					if (!exported) {
						i = i + (1) >> 0;
						continue;
					}
					reflectMethods = $append(reflectMethods, new method.ptr(newNameOff($clone(newName(internalStr(m.name), "", exported, false), name)), newTypeOff(reflectType(m.typ)), 0, 0));
					i = i + (1) >> 0;
				}
				xcount = ((reflectMethods.$length << 16 >>> 16));
				i$1 = 0;
				while (true) {
					if (!(i$1 < $parseInt(methodSet.length))) { break; }
					m$1 = methodSet[i$1];
					exported$1 = internalStr(m$1.pkg) === "";
					if (exported$1) {
						i$1 = i$1 + (1) >> 0;
						continue;
					}
					reflectMethods = $append(reflectMethods, new method.ptr(newNameOff($clone(newName(internalStr(m$1.name), "", exported$1, false), name)), newTypeOff(reflectType(m$1.typ)), 0, 0));
					i$1 = i$1 + (1) >> 0;
				}
				ut = new uncommonType.ptr(newNameOff($clone(newName(internalStr(typ.pkg), "", false, false), name)), (($parseInt(methodSet.length) << 16 >>> 16)), xcount, 0, reflectMethods);
				_key = rt; (uncommonTypeMap || $throwRuntimeError("assignment to entry in nil map")).set(ptrType$1.keyFor(_key), { k: _key, v: ut });
				ut[$externalize(idJsType, $String)] = typ;
			}
			_1 = rt.Kind();
			if (_1 === (17)) {
				setKindType(rt, new arrayType.ptr(new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$6.nil, 0, 0), reflectType(typ.elem), ptrType$1.nil, ((($parseInt(typ.len) >> 0) >>> 0))));
			} else if (_1 === (18)) {
				dir = 3;
				if (!!(typ.sendOnly)) {
					dir = 2;
				}
				if (!!(typ.recvOnly)) {
					dir = 1;
				}
				setKindType(rt, new chanType.ptr(new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$6.nil, 0, 0), reflectType(typ.elem), ((dir >>> 0))));
			} else if (_1 === (19)) {
				params = typ.params;
				in$1 = $makeSlice(sliceType$2, $parseInt(params.length));
				_ref = in$1;
				_i = 0;
				while (true) {
					if (!(_i < _ref.$length)) { break; }
					i$2 = _i;
					((i$2 < 0 || i$2 >= in$1.$length) ? ($throwRuntimeError("index out of range"), undefined) : in$1.$array[in$1.$offset + i$2] = reflectType(params[i$2]));
					_i++;
				}
				results = typ.results;
				out = $makeSlice(sliceType$2, $parseInt(results.length));
				_ref$1 = out;
				_i$1 = 0;
				while (true) {
					if (!(_i$1 < _ref$1.$length)) { break; }
					i$3 = _i$1;
					((i$3 < 0 || i$3 >= out.$length) ? ($throwRuntimeError("index out of range"), undefined) : out.$array[out.$offset + i$3] = reflectType(results[i$3]));
					_i$1++;
				}
				outCount = (($parseInt(results.length) << 16 >>> 16));
				if (!!(typ.variadic)) {
					outCount = (outCount | (32768)) >>> 0;
				}
				setKindType(rt, new funcType.ptr($clone(rt, rtype), (($parseInt(params.length) << 16 >>> 16)), outCount, in$1, out));
			} else if (_1 === (20)) {
				methods = typ.methods;
				imethods = $makeSlice(sliceType$9, $parseInt(methods.length));
				_ref$2 = imethods;
				_i$2 = 0;
				while (true) {
					if (!(_i$2 < _ref$2.$length)) { break; }
					i$4 = _i$2;
					m$2 = methods[i$4];
					imethod.copy(((i$4 < 0 || i$4 >= imethods.$length) ? ($throwRuntimeError("index out of range"), undefined) : imethods.$array[imethods.$offset + i$4]), new imethod.ptr(newNameOff($clone(newName(internalStr(m$2.name), "", internalStr(m$2.pkg) === "", false), name)), newTypeOff(reflectType(m$2.typ))));
					_i$2++;
				}
				setKindType(rt, new interfaceType.ptr($clone(rt, rtype), $clone(newName(internalStr(typ.pkg), "", false, false), name), imethods));
			} else if (_1 === (21)) {
				setKindType(rt, new mapType.ptr(new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$6.nil, 0, 0), reflectType(typ.key), reflectType(typ.elem), ptrType$1.nil, $throwNilPointerError, 0, 0, 0, 0));
			} else if (_1 === (22)) {
				setKindType(rt, new ptrType.ptr(new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$6.nil, 0, 0), reflectType(typ.elem)));
			} else if (_1 === (23)) {
				setKindType(rt, new sliceType.ptr(new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$6.nil, 0, 0), reflectType(typ.elem)));
			} else if (_1 === (25)) {
				fields = typ.fields;
				reflectFields = $makeSlice(sliceType$10, $parseInt(fields.length));
				_ref$3 = reflectFields;
				_i$3 = 0;
				while (true) {
					if (!(_i$3 < _ref$3.$length)) { break; }
					i$5 = _i$3;
					f = fields[i$5];
					structField.copy(((i$5 < 0 || i$5 >= reflectFields.$length) ? ($throwRuntimeError("index out of range"), undefined) : reflectFields.$array[reflectFields.$offset + i$5]), new structField.ptr($clone(newName(internalStr(f.name), internalStr(f.tag), !!(f.exported), !!(f.embedded)), name), reflectType(f.typ), ((i$5 >>> 0))));
					_i$3++;
				}
				setKindType(rt, new structType.ptr($clone(rt, rtype), $clone(newName(internalStr(typ.pkgPath), "", false, false), name), reflectFields));
			}
		}
		return ((typ[$externalize(idReflectType, $String)]));
	};
	setKindType = function(rt, kindType) {
		var kindType, rt;
		rt[$externalize(idKindType, $String)] = kindType;
		kindType[$externalize(idRtype, $String)] = rt;
	};
	uncommonType.ptr.prototype.methods = function() {
		var t;
		t = this;
		return t._methods;
	};
	uncommonType.prototype.methods = function() { return this.$val.methods(); };
	uncommonType.ptr.prototype.exportedMethods = function() {
		var t;
		t = this;
		return $subslice(t._methods, 0, t.xcount, t.xcount);
	};
	uncommonType.prototype.exportedMethods = function() { return this.$val.exportedMethods(); };
	rtype.ptr.prototype.uncommon = function() {
		var _entry, t;
		t = this;
		return (_entry = $mapIndex(uncommonTypeMap,ptrType$1.keyFor(t)), _entry !== undefined ? _entry.v : ptrType$4.nil);
	};
	rtype.prototype.uncommon = function() { return this.$val.uncommon(); };
	funcType.ptr.prototype.in$ = function() {
		var t;
		t = this;
		return t._in;
	};
	funcType.prototype.in$ = function() { return this.$val.in$(); };
	funcType.ptr.prototype.out = function() {
		var t;
		t = this;
		return t._out;
	};
	funcType.prototype.out = function() { return this.$val.out(); };
	name.ptr.prototype.name = function() {
		var _entry, n, s;
		s = "";
		n = this;
		s = (_entry = $mapIndex(nameMap,ptrType$6.keyFor(n.bytes)), _entry !== undefined ? _entry.v : ptrType$8.nil).name;
		return s;
	};
	name.prototype.name = function() { return this.$val.name(); };
	name.ptr.prototype.tag = function() {
		var _entry, n, s;
		s = "";
		n = this;
		s = (_entry = $mapIndex(nameMap,ptrType$6.keyFor(n.bytes)), _entry !== undefined ? _entry.v : ptrType$8.nil).tag;
		return s;
	};
	name.prototype.tag = function() { return this.$val.tag(); };
	name.ptr.prototype.pkgPath = function() {
		var n;
		n = this;
		return "";
	};
	name.prototype.pkgPath = function() { return this.$val.pkgPath(); };
	name.ptr.prototype.isExported = function() {
		var _entry, n;
		n = this;
		return (_entry = $mapIndex(nameMap,ptrType$6.keyFor(n.bytes)), _entry !== undefined ? _entry.v : ptrType$8.nil).exported;
	};
	name.prototype.isExported = function() { return this.$val.isExported(); };
	name.ptr.prototype.embedded = function() {
		var _entry, n;
		n = this;
		return (_entry = $mapIndex(nameMap,ptrType$6.keyFor(n.bytes)), _entry !== undefined ? _entry.v : ptrType$8.nil).embedded;
	};
	name.prototype.embedded = function() { return this.$val.embedded(); };
	newName = function(n, tag, exported, embedded) {
		var _key, b, embedded, exported, n, tag;
		b = $newDataPointer(0, ptrType$6);
		_key = b; (nameMap || $throwRuntimeError("assignment to entry in nil map")).set(ptrType$6.keyFor(_key), { k: _key, v: new nameData.ptr(n, tag, exported, embedded) });
		return new name.ptr(b);
	};
	rtype.ptr.prototype.nameOff = function(off) {
		var off, t, x;
		t = this;
		return (x = ((off >> 0)), ((x < 0 || x >= nameOffList.$length) ? ($throwRuntimeError("index out of range"), undefined) : nameOffList.$array[nameOffList.$offset + x]));
	};
	rtype.prototype.nameOff = function(off) { return this.$val.nameOff(off); };
	newNameOff = function(n) {
		var i, n;
		i = nameOffList.$length;
		nameOffList = $append(nameOffList, n);
		return ((i >> 0));
	};
	rtype.ptr.prototype.typeOff = function(off) {
		var off, t, x;
		t = this;
		return (x = ((off >> 0)), ((x < 0 || x >= typeOffList.$length) ? ($throwRuntimeError("index out of range"), undefined) : typeOffList.$array[typeOffList.$offset + x]));
	};
	rtype.prototype.typeOff = function(off) { return this.$val.typeOff(off); };
	newTypeOff = function(t) {
		var i, t;
		i = typeOffList.$length;
		typeOffList = $append(typeOffList, t);
		return ((i >> 0));
	};
	internalStr = function(strObj) {
		var c, strObj;
		c = new structType$2.ptr("");
		c.str = strObj;
		return c.str;
	};
	isWrapped = function(typ) {
		var typ;
		return !!(jsType(typ).wrapped);
	};
	copyStruct = function(dst, src, typ) {
		var dst, fields, i, prop, src, typ;
		fields = jsType(typ).fields;
		i = 0;
		while (true) {
			if (!(i < $parseInt(fields.length))) { break; }
			prop = $internalize(fields[i].prop, $String);
			dst[$externalize(prop, $String)] = src[$externalize(prop, $String)];
			i = i + (1) >> 0;
		}
	};
	makeValue = function(t, v, fl) {
		var {$24r, $24r$1, _r, _r$1, _r$2, _r$3, _r$4, _r$5, _v, _v$1, fl, rt, t, v, $s, $r, $c} = $restore(this, {t, v, fl});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		_r = t.common(); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		rt = _r;
		_r$1 = t.Kind(); /* */ $s = 6; case 6: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
		if (_r$1 === 17) { _v$1 = true; $s = 5; continue s; }
		_r$2 = t.Kind(); /* */ $s = 7; case 7: if($c) { $c = false; _r$2 = _r$2.$blk(); } if (_r$2 && _r$2.$blk !== undefined) { break s; }
		_v$1 = _r$2 === 25; case 5:
		if (_v$1) { _v = true; $s = 4; continue s; }
		_r$3 = t.Kind(); /* */ $s = 8; case 8: if($c) { $c = false; _r$3 = _r$3.$blk(); } if (_r$3 && _r$3.$blk !== undefined) { break s; }
		_v = _r$3 === 22; case 4:
		/* */ if (_v) { $s = 2; continue; }
		/* */ $s = 3; continue;
		/* if (_v) { */ case 2:
			_r$4 = t.Kind(); /* */ $s = 9; case 9: if($c) { $c = false; _r$4 = _r$4.$blk(); } if (_r$4 && _r$4.$blk !== undefined) { break s; }
			$24r = new Value.ptr(rt, (v), (fl | ((_r$4 >>> 0))) >>> 0);
			$s = 10; case 10: return $24r;
		/* } */ case 3:
		_r$5 = t.Kind(); /* */ $s = 11; case 11: if($c) { $c = false; _r$5 = _r$5.$blk(); } if (_r$5 && _r$5.$blk !== undefined) { break s; }
		$24r$1 = new Value.ptr(rt, ($newDataPointer(v, jsType(rt.ptrTo()))), (((fl | ((_r$5 >>> 0))) >>> 0) | 128) >>> 0);
		$s = 12; case 12: return $24r$1;
		/* */ } return; } var $f = {$blk: makeValue, $c: true, $r, $24r, $24r$1, _r, _r$1, _r$2, _r$3, _r$4, _r$5, _v, _v$1, fl, rt, t, v, $s};return $f;
	};
	TypeOf = function(i) {
		var i;
		if (!initialized) {
			return new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$6.nil, 0, 0);
		}
		if ($interfaceIsEqual(i, $ifaceNil)) {
			return $ifaceNil;
		}
		return reflectType(i.constructor);
	};
	$pkg.TypeOf = TypeOf;
	ValueOf = function(i) {
		var {$24r, _r, i, $s, $r, $c} = $restore(this, {i});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		if ($interfaceIsEqual(i, $ifaceNil)) {
			$s = -1; return new Value.ptr(ptrType$1.nil, 0, 0);
		}
		_r = makeValue(reflectType(i.constructor), i.$val, 0); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		$24r = _r;
		$s = 2; case 2: return $24r;
		/* */ } return; } var $f = {$blk: ValueOf, $c: true, $r, $24r, _r, i, $s};return $f;
	};
	$pkg.ValueOf = ValueOf;
	FuncOf = function(in$1, out, variadic) {
		var {_i, _i$1, _r, _ref, _ref$1, _v, _v$1, i, i$1, in$1, jsIn, jsOut, out, v, v$1, variadic, x, $s, $r, $c} = $restore(this, {in$1, out, variadic});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		if (!(variadic)) { _v = false; $s = 3; continue s; }
		if (in$1.$length === 0) { _v$1 = true; $s = 4; continue s; }
		_r = (x = in$1.$length - 1 >> 0, ((x < 0 || x >= in$1.$length) ? ($throwRuntimeError("index out of range"), undefined) : in$1.$array[in$1.$offset + x])).Kind(); /* */ $s = 5; case 5: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		_v$1 = !((_r === 23)); case 4:
		_v = _v$1; case 3:
		/* */ if (_v) { $s = 1; continue; }
		/* */ $s = 2; continue;
		/* if (_v) { */ case 1:
			$panic(new $String("reflect.FuncOf: last arg of variadic func must be slice"));
		/* } */ case 2:
		jsIn = $makeSlice(sliceType$8, in$1.$length);
		_ref = in$1;
		_i = 0;
		while (true) {
			if (!(_i < _ref.$length)) { break; }
			i = _i;
			v = ((_i < 0 || _i >= _ref.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref.$array[_ref.$offset + _i]);
			((i < 0 || i >= jsIn.$length) ? ($throwRuntimeError("index out of range"), undefined) : jsIn.$array[jsIn.$offset + i] = jsType(v));
			_i++;
		}
		jsOut = $makeSlice(sliceType$8, out.$length);
		_ref$1 = out;
		_i$1 = 0;
		while (true) {
			if (!(_i$1 < _ref$1.$length)) { break; }
			i$1 = _i$1;
			v$1 = ((_i$1 < 0 || _i$1 >= _ref$1.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref$1.$array[_ref$1.$offset + _i$1]);
			((i$1 < 0 || i$1 >= jsOut.$length) ? ($throwRuntimeError("index out of range"), undefined) : jsOut.$array[jsOut.$offset + i$1] = jsType(v$1));
			_i$1++;
		}
		$s = -1; return reflectType($funcType($externalize(jsIn, sliceType$8), $externalize(jsOut, sliceType$8), $externalize(variadic, $Bool)));
		/* */ } return; } var $f = {$blk: FuncOf, $c: true, $r, _i, _i$1, _r, _ref, _ref$1, _v, _v$1, i, i$1, in$1, jsIn, jsOut, out, v, v$1, variadic, x, $s};return $f;
	};
	$pkg.FuncOf = FuncOf;
	rtype.ptr.prototype.ptrTo = function() {
		var t;
		t = this;
		return reflectType($ptrType(jsType(t)));
	};
	rtype.prototype.ptrTo = function() { return this.$val.ptrTo(); };
	SliceOf = function(t) {
		var t;
		return reflectType($sliceType(jsType(t)));
	};
	$pkg.SliceOf = SliceOf;
	unsafe_New = function(typ) {
		var _1, typ;
		_1 = typ.Kind();
		if (_1 === (25)) {
			return (new (jsType(typ).ptr)());
		} else if (_1 === (17)) {
			return (jsType(typ).zero());
		} else {
			return ($newDataPointer(jsType(typ).zero(), jsType(typ.ptrTo())));
		}
	};
	typedmemmove = function(t, dst, src) {
		var dst, src, t;
		dst.$set(src.$get());
	};
	keyFor = function(t, key) {
		var k, key, kv, t;
		kv = key;
		if (!(kv.$get === undefined)) {
			kv = kv.$get();
		}
		k = $internalize(jsType(t.Key()).keyFor(kv), $String);
		return [kv, k];
	};
	mapaccess = function(t, m, key) {
		var _tuple, entry, k, key, m, t;
		_tuple = keyFor(t, key);
		k = _tuple[1];
		entry = m.get($externalize(k, $String));
		if (entry === undefined) {
			return 0;
		}
		return ($newDataPointer(entry.v, jsType(PtrTo(t.Elem()))));
	};
	mapIter.ptr.prototype.skipUntilValidKey = function() {
		var iter, k;
		iter = this;
		while (true) {
			if (!(iter.i < $parseInt(iter.keys.length))) { break; }
			k = iter.keys[iter.i];
			if (!(iter.m.get(k) === undefined)) {
				break;
			}
			iter.i = iter.i + (1) >> 0;
		}
	};
	mapIter.prototype.skipUntilValidKey = function() { return this.$val.skipUntilValidKey(); };
	mapiterinit = function(t, m) {
		var m, t;
		return (new mapIter.ptr(t, m, $global.Array.from(m.keys()), 0, null));
	};
	mapiterkey = function(it) {
		var {$24r, _r, _r$1, _r$2, it, iter, k, kv, $s, $r, $c} = $restore(this, {it});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		iter = ($pointerOfStructConversion(it, ptrType$9));
		kv = null;
		if (!(iter.last === null)) {
			kv = iter.last;
		} else {
			iter.skipUntilValidKey();
			if (iter.i === $parseInt(iter.keys.length)) {
				$s = -1; return 0;
			}
			k = iter.keys[iter.i];
			kv = iter.m.get(k);
			iter.last = kv;
		}
		_r = $assertType(iter.t, TypeEx).Key(); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		_r$1 = PtrTo(_r); /* */ $s = 2; case 2: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
		_r$2 = jsType(_r$1); /* */ $s = 3; case 3: if($c) { $c = false; _r$2 = _r$2.$blk(); } if (_r$2 && _r$2.$blk !== undefined) { break s; }
		$24r = ($newDataPointer(kv.k, _r$2));
		$s = 4; case 4: return $24r;
		/* */ } return; } var $f = {$blk: mapiterkey, $c: true, $r, $24r, _r, _r$1, _r$2, it, iter, k, kv, $s};return $f;
	};
	mapiternext = function(it) {
		var it, iter;
		iter = ($pointerOfStructConversion(it, ptrType$9));
		iter.last = null;
		iter.i = iter.i + (1) >> 0;
	};
	maplen = function(m) {
		var m;
		return $parseInt(m.size) >> 0;
	};
	methodReceiver = function(op, v, i) {
		var _, fn, i, m, m$1, ms, op, prop, rcvr, t, tt, v, x;
		_ = ptrType$1.nil;
		t = ptrType$5.nil;
		fn = 0;
		prop = "";
		if (v.typ.Kind() === 20) {
			tt = (v.typ.kindType);
			if (i < 0 || i >= tt.methods.$length) {
				$panic(new $String("reflect: internal error: invalid method index"));
			}
			m = (x = tt.methods, ((i < 0 || i >= x.$length) ? ($throwRuntimeError("index out of range"), undefined) : x.$array[x.$offset + i]));
			if (!$clone(tt.rtype.nameOff(m.name), name).isExported()) {
				$panic(new $String("reflect: " + op + " of unexported method"));
			}
			t = (tt.rtype.typeOff(m.typ).kindType);
			prop = $clone(tt.rtype.nameOff(m.name), name).name();
		} else {
			ms = v.typ.exportedMethods();
			if (((i >>> 0)) >= ((ms.$length >>> 0))) {
				$panic(new $String("reflect: internal error: invalid method index"));
			}
			m$1 = $clone(((i < 0 || i >= ms.$length) ? ($throwRuntimeError("index out of range"), undefined) : ms.$array[ms.$offset + i]), method);
			if (!$clone(v.typ.nameOff(m$1.name), name).isExported()) {
				$panic(new $String("reflect: " + op + " of unexported method"));
			}
			t = (v.typ.typeOff(m$1.mtyp).kindType);
			prop = $internalize($methodSet(jsType(v.typ))[i].prop, $String);
		}
		rcvr = $clone(v, Value).object();
		if (isWrapped(v.typ)) {
			rcvr = new (jsType(v.typ))(rcvr);
		}
		fn = (rcvr[$externalize(prop, $String)]);
		return [_, t, fn];
	};
	valueInterface = function(v) {
		var {_r, cv, v, $s, $r, $c} = $restore(this, {v});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		if (v.flag === 0) {
			$panic(new ValueError.ptr("reflect.Value.Interface", 0));
		}
		/* */ if (!((((v.flag & 512) >>> 0) === 0))) { $s = 1; continue; }
		/* */ $s = 2; continue;
		/* if (!((((v.flag & 512) >>> 0) === 0))) { */ case 1:
			_r = makeMethodValue("Interface", $clone(v, Value)); /* */ $s = 3; case 3: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
			Value.copy(v, _r);
		/* } */ case 2:
		if (isWrapped(v.typ)) {
			if (!((((v.flag & 128) >>> 0) === 0)) && ($clone(v, Value).Kind() === 25)) {
				cv = jsType(v.typ).zero();
				copyStruct(cv, $clone(v, Value).object(), v.typ);
				$s = -1; return ((new (jsType(v.typ))(cv)));
			}
			$s = -1; return ((new (jsType(v.typ))($clone(v, Value).object())));
		}
		$s = -1; return (($clone(v, Value).object()));
		/* */ } return; } var $f = {$blk: valueInterface, $c: true, $r, _r, cv, v, $s};return $f;
	};
	ifaceE2I = function(t, src, dst) {
		var dst, src, t;
		dst.$set(src);
	};
	methodName = function() {
		return "?FIXME?";
	};
	makeMethodValue = function(op, v) {
		var {$24r, _r, _tuple, fn, fv, op, rcvr, v, $s, $r, $c} = $restore(this, {op, v});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		fn = [fn];
		rcvr = [rcvr];
		if (((v.flag & 512) >>> 0) === 0) {
			$panic(new $String("reflect: internal error: invalid use of makePartialFunc"));
		}
		_tuple = methodReceiver(op, $clone(v, Value), ((v.flag >> 0)) >> 10 >> 0);
		fn[0] = _tuple[2];
		rcvr[0] = $clone(v, Value).object();
		if (isWrapped(v.typ)) {
			rcvr[0] = new (jsType(v.typ))(rcvr[0]);
		}
		fv = js.MakeFunc((function(fn, rcvr) { return function(this$1, arguments$1) {
			var arguments$1, this$1;
			return new $jsObjectPtr(fn[0].apply(rcvr[0], $externalize(arguments$1, sliceType$8)));
		}; })(fn, rcvr));
		_r = $clone(v, Value).Type().common(); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		$24r = new Value.ptr(_r, (fv), (new flag(v.flag).ro() | 19) >>> 0);
		$s = 2; case 2: return $24r;
		/* */ } return; } var $f = {$blk: makeMethodValue, $c: true, $r, $24r, _r, _tuple, fn, fv, op, rcvr, v, $s};return $f;
	};
	wrapJsObject = function(typ, val) {
		var typ, val;
		if ($interfaceIsEqual(typ, jsObjectPtr)) {
			return new (jsType(jsObjectPtr))(val);
		}
		return val;
	};
	unwrapJsObject = function(typ, val) {
		var typ, val;
		if ($interfaceIsEqual(typ, jsObjectPtr)) {
			return val.object;
		}
		return val;
	};
	getJsTag = function(tag) {
		var _tuple, i, name$1, qvalue, tag, value;
		while (true) {
			if (!(!(tag === ""))) { break; }
			i = 0;
			while (true) {
				if (!(i < tag.length && (tag.charCodeAt(i) === 32))) { break; }
				i = i + (1) >> 0;
			}
			tag = $substring(tag, i);
			if (tag === "") {
				break;
			}
			i = 0;
			while (true) {
				if (!(i < tag.length && !((tag.charCodeAt(i) === 32)) && !((tag.charCodeAt(i) === 58)) && !((tag.charCodeAt(i) === 34)))) { break; }
				i = i + (1) >> 0;
			}
			if ((i + 1 >> 0) >= tag.length || !((tag.charCodeAt(i) === 58)) || !((tag.charCodeAt((i + 1 >> 0)) === 34))) {
				break;
			}
			name$1 = ($substring(tag, 0, i));
			tag = $substring(tag, (i + 1 >> 0));
			i = 1;
			while (true) {
				if (!(i < tag.length && !((tag.charCodeAt(i) === 34)))) { break; }
				if (tag.charCodeAt(i) === 92) {
					i = i + (1) >> 0;
				}
				i = i + (1) >> 0;
			}
			if (i >= tag.length) {
				break;
			}
			qvalue = ($substring(tag, 0, (i + 1 >> 0)));
			tag = $substring(tag, (i + 1 >> 0));
			if (name$1 === "js") {
				_tuple = unquote(qvalue);
				value = _tuple[0];
				return value;
			}
		}
		return "";
	};
	PtrTo = function(t) {
		var t;
		return $assertType(t, ptrType$1).ptrTo();
	};
	$pkg.PtrTo = PtrTo;
	copyVal = function(typ, fl, ptr) {
		var c, fl, ptr, typ;
		if (ifaceIndir(typ)) {
			c = unsafe_New(typ);
			typedmemmove(typ, c, ptr);
			return new Value.ptr(typ, c, (fl | 128) >>> 0);
		}
		return new Value.ptr(typ, (ptr).$get(), fl);
	};
	Value.methods = [{prop: "pointer", name: "pointer", pkg: "internal/reflectlite", typ: $funcType([], [$UnsafePointer], false)}, {prop: "CanSet", name: "CanSet", pkg: "", typ: $funcType([], [$Bool], false)}, {prop: "IsValid", name: "IsValid", pkg: "", typ: $funcType([], [$Bool], false)}, {prop: "Kind", name: "Kind", pkg: "", typ: $funcType([], [Kind], false)}, {prop: "numMethod", name: "numMethod", pkg: "internal/reflectlite", typ: $funcType([], [$Int], false)}, {prop: "Type", name: "Type", pkg: "", typ: $funcType([], [Type], false)}, {prop: "object", name: "object", pkg: "internal/reflectlite", typ: $funcType([], [ptrType$2], false)}, {prop: "assignTo", name: "assignTo", pkg: "internal/reflectlite", typ: $funcType([$String, ptrType$1, $UnsafePointer], [Value], false)}, {prop: "call", name: "call", pkg: "internal/reflectlite", typ: $funcType([$String, sliceType$6], [sliceType$6], false)}, {prop: "Cap", name: "Cap", pkg: "", typ: $funcType([], [$Int], false)}, {prop: "Index", name: "Index", pkg: "", typ: $funcType([$Int], [Value], false)}, {prop: "InterfaceData", name: "InterfaceData", pkg: "", typ: $funcType([], [arrayType$2], false)}, {prop: "IsNil", name: "IsNil", pkg: "", typ: $funcType([], [$Bool], false)}, {prop: "Len", name: "Len", pkg: "", typ: $funcType([], [$Int], false)}, {prop: "Pointer", name: "Pointer", pkg: "", typ: $funcType([], [$Uintptr], false)}, {prop: "Set", name: "Set", pkg: "", typ: $funcType([Value], [], false)}, {prop: "SetBytes", name: "SetBytes", pkg: "", typ: $funcType([sliceType$13], [], false)}, {prop: "SetCap", name: "SetCap", pkg: "", typ: $funcType([$Int], [], false)}, {prop: "SetLen", name: "SetLen", pkg: "", typ: $funcType([$Int], [], false)}, {prop: "Slice", name: "Slice", pkg: "", typ: $funcType([$Int, $Int], [Value], false)}, {prop: "Slice3", name: "Slice3", pkg: "", typ: $funcType([$Int, $Int, $Int], [Value], false)}, {prop: "Close", name: "Close", pkg: "", typ: $funcType([], [], false)}, {prop: "Elem", name: "Elem", pkg: "", typ: $funcType([], [Value], false)}, {prop: "NumField", name: "NumField", pkg: "", typ: $funcType([], [$Int], false)}, {prop: "MapKeys", name: "MapKeys", pkg: "", typ: $funcType([], [sliceType$6], false)}, {prop: "MapIndex", name: "MapIndex", pkg: "", typ: $funcType([Value], [Value], false)}, {prop: "Field", name: "Field", pkg: "", typ: $funcType([$Int], [Value], false)}];
	flag.methods = [{prop: "kind", name: "kind", pkg: "internal/reflectlite", typ: $funcType([], [Kind], false)}, {prop: "ro", name: "ro", pkg: "internal/reflectlite", typ: $funcType([], [flag], false)}, {prop: "mustBeExported", name: "mustBeExported", pkg: "internal/reflectlite", typ: $funcType([], [], false)}, {prop: "mustBeAssignable", name: "mustBeAssignable", pkg: "internal/reflectlite", typ: $funcType([], [], false)}, {prop: "mustBe", name: "mustBe", pkg: "internal/reflectlite", typ: $funcType([Kind], [], false)}];
	ptrType$10.methods = [{prop: "Error", name: "Error", pkg: "", typ: $funcType([], [$String], false)}];
	Kind.methods = [{prop: "String", name: "String", pkg: "", typ: $funcType([], [$String], false)}];
	ptrType$1.methods = [{prop: "String", name: "String", pkg: "", typ: $funcType([], [$String], false)}, {prop: "Size", name: "Size", pkg: "", typ: $funcType([], [$Uintptr], false)}, {prop: "Kind", name: "Kind", pkg: "", typ: $funcType([], [Kind], false)}, {prop: "pointers", name: "pointers", pkg: "internal/reflectlite", typ: $funcType([], [$Bool], false)}, {prop: "common", name: "common", pkg: "internal/reflectlite", typ: $funcType([], [ptrType$1], false)}, {prop: "exportedMethods", name: "exportedMethods", pkg: "internal/reflectlite", typ: $funcType([], [sliceType$5], false)}, {prop: "NumMethod", name: "NumMethod", pkg: "", typ: $funcType([], [$Int], false)}, {prop: "PkgPath", name: "PkgPath", pkg: "", typ: $funcType([], [$String], false)}, {prop: "hasName", name: "hasName", pkg: "internal/reflectlite", typ: $funcType([], [$Bool], false)}, {prop: "Name", name: "Name", pkg: "", typ: $funcType([], [$String], false)}, {prop: "chanDir", name: "chanDir", pkg: "internal/reflectlite", typ: $funcType([], [chanDir], false)}, {prop: "Elem", name: "Elem", pkg: "", typ: $funcType([], [Type], false)}, {prop: "In", name: "In", pkg: "", typ: $funcType([$Int], [Type], false)}, {prop: "Len", name: "Len", pkg: "", typ: $funcType([], [$Int], false)}, {prop: "NumIn", name: "NumIn", pkg: "", typ: $funcType([], [$Int], false)}, {prop: "NumOut", name: "NumOut", pkg: "", typ: $funcType([], [$Int], false)}, {prop: "Out", name: "Out", pkg: "", typ: $funcType([$Int], [Type], false)}, {prop: "Implements", name: "Implements", pkg: "", typ: $funcType([Type], [$Bool], false)}, {prop: "AssignableTo", name: "AssignableTo", pkg: "", typ: $funcType([Type], [$Bool], false)}, {prop: "Comparable", name: "Comparable", pkg: "", typ: $funcType([], [$Bool], false)}, {prop: "IsVariadic", name: "IsVariadic", pkg: "", typ: $funcType([], [$Bool], false)}, {prop: "kindType", name: "kindType", pkg: "internal/reflectlite", typ: $funcType([], [ptrType$1], false)}, {prop: "Field", name: "Field", pkg: "", typ: $funcType([$Int], [structField], false)}, {prop: "Key", name: "Key", pkg: "", typ: $funcType([], [Type], false)}, {prop: "NumField", name: "NumField", pkg: "", typ: $funcType([], [$Int], false)}, {prop: "Method", name: "Method", pkg: "", typ: $funcType([$Int], [Method], false)}, {prop: "uncommon", name: "uncommon", pkg: "internal/reflectlite", typ: $funcType([], [ptrType$4], false)}, {prop: "nameOff", name: "nameOff", pkg: "internal/reflectlite", typ: $funcType([nameOff], [name], false)}, {prop: "typeOff", name: "typeOff", pkg: "internal/reflectlite", typ: $funcType([typeOff], [ptrType$1], false)}, {prop: "ptrTo", name: "ptrTo", pkg: "internal/reflectlite", typ: $funcType([], [ptrType$1], false)}];
	ptrType$11.methods = [{prop: "NumMethod", name: "NumMethod", pkg: "", typ: $funcType([], [$Int], false)}];
	ptrType$12.methods = [{prop: "embedded", name: "embedded", pkg: "internal/reflectlite", typ: $funcType([], [$Bool], false)}];
	ptrType$13.methods = [{prop: "Error", name: "Error", pkg: "", typ: $funcType([], [$String], false)}];
	ptrType$4.methods = [{prop: "methods", name: "methods", pkg: "internal/reflectlite", typ: $funcType([], [sliceType$5], false)}, {prop: "exportedMethods", name: "exportedMethods", pkg: "internal/reflectlite", typ: $funcType([], [sliceType$5], false)}];
	ptrType$5.methods = [{prop: "in$", name: "in", pkg: "internal/reflectlite", typ: $funcType([], [sliceType$2], false)}, {prop: "out", name: "out", pkg: "internal/reflectlite", typ: $funcType([], [sliceType$2], false)}];
	name.methods = [{prop: "data", name: "data", pkg: "internal/reflectlite", typ: $funcType([$Int, $String], [ptrType$6], false)}, {prop: "hasTag", name: "hasTag", pkg: "internal/reflectlite", typ: $funcType([], [$Bool], false)}, {prop: "readVarint", name: "readVarint", pkg: "internal/reflectlite", typ: $funcType([$Int], [$Int, $Int], false)}, {prop: "name", name: "name", pkg: "internal/reflectlite", typ: $funcType([], [$String], false)}, {prop: "tag", name: "tag", pkg: "internal/reflectlite", typ: $funcType([], [$String], false)}, {prop: "pkgPath", name: "pkgPath", pkg: "internal/reflectlite", typ: $funcType([], [$String], false)}, {prop: "isExported", name: "isExported", pkg: "internal/reflectlite", typ: $funcType([], [$Bool], false)}, {prop: "embedded", name: "embedded", pkg: "internal/reflectlite", typ: $funcType([], [$Bool], false)}];
	ptrType$9.methods = [{prop: "skipUntilValidKey", name: "skipUntilValidKey", pkg: "internal/reflectlite", typ: $funcType([], [], false)}];
	Value.init("internal/reflectlite", [{prop: "typ", name: "typ", embedded: false, exported: false, typ: ptrType$1, tag: ""}, {prop: "ptr", name: "ptr", embedded: false, exported: false, typ: $UnsafePointer, tag: ""}, {prop: "flag", name: "flag", embedded: true, exported: false, typ: flag, tag: ""}]);
	ValueError.init("", [{prop: "Method", name: "Method", embedded: false, exported: true, typ: $String, tag: ""}, {prop: "Kind", name: "Kind", embedded: false, exported: true, typ: Kind, tag: ""}]);
	Type.init([{prop: "AssignableTo", name: "AssignableTo", pkg: "", typ: $funcType([Type], [$Bool], false)}, {prop: "Comparable", name: "Comparable", pkg: "", typ: $funcType([], [$Bool], false)}, {prop: "Elem", name: "Elem", pkg: "", typ: $funcType([], [Type], false)}, {prop: "Implements", name: "Implements", pkg: "", typ: $funcType([Type], [$Bool], false)}, {prop: "Kind", name: "Kind", pkg: "", typ: $funcType([], [Kind], false)}, {prop: "Name", name: "Name", pkg: "", typ: $funcType([], [$String], false)}, {prop: "PkgPath", name: "PkgPath", pkg: "", typ: $funcType([], [$String], false)}, {prop: "Size", name: "Size", pkg: "", typ: $funcType([], [$Uintptr], false)}, {prop: "String", name: "String", pkg: "", typ: $funcType([], [$String], false)}, {prop: "common", name: "common", pkg: "internal/reflectlite", typ: $funcType([], [ptrType$1], false)}, {prop: "uncommon", name: "uncommon", pkg: "internal/reflectlite", typ: $funcType([], [ptrType$4], false)}]);
	rtype.init("internal/reflectlite", [{prop: "size", name: "size", embedded: false, exported: false, typ: $Uintptr, tag: ""}, {prop: "ptrdata", name: "ptrdata", embedded: false, exported: false, typ: $Uintptr, tag: ""}, {prop: "hash", name: "hash", embedded: false, exported: false, typ: $Uint32, tag: ""}, {prop: "tflag", name: "tflag", embedded: false, exported: false, typ: tflag, tag: ""}, {prop: "align", name: "align", embedded: false, exported: false, typ: $Uint8, tag: ""}, {prop: "fieldAlign", name: "fieldAlign", embedded: false, exported: false, typ: $Uint8, tag: ""}, {prop: "kind", name: "kind", embedded: false, exported: false, typ: $Uint8, tag: ""}, {prop: "equal", name: "equal", embedded: false, exported: false, typ: funcType$2, tag: ""}, {prop: "gcdata", name: "gcdata", embedded: false, exported: false, typ: ptrType$6, tag: ""}, {prop: "str", name: "str", embedded: false, exported: false, typ: nameOff, tag: ""}, {prop: "ptrToThis", name: "ptrToThis", embedded: false, exported: false, typ: typeOff, tag: ""}]);
	method.init("internal/reflectlite", [{prop: "name", name: "name", embedded: false, exported: false, typ: nameOff, tag: ""}, {prop: "mtyp", name: "mtyp", embedded: false, exported: false, typ: typeOff, tag: ""}, {prop: "ifn", name: "ifn", embedded: false, exported: false, typ: textOff, tag: ""}, {prop: "tfn", name: "tfn", embedded: false, exported: false, typ: textOff, tag: ""}]);
	arrayType.init("internal/reflectlite", [{prop: "rtype", name: "rtype", embedded: true, exported: false, typ: rtype, tag: ""}, {prop: "elem", name: "elem", embedded: false, exported: false, typ: ptrType$1, tag: ""}, {prop: "slice", name: "slice", embedded: false, exported: false, typ: ptrType$1, tag: ""}, {prop: "len", name: "len", embedded: false, exported: false, typ: $Uintptr, tag: ""}]);
	chanType.init("internal/reflectlite", [{prop: "rtype", name: "rtype", embedded: true, exported: false, typ: rtype, tag: ""}, {prop: "elem", name: "elem", embedded: false, exported: false, typ: ptrType$1, tag: ""}, {prop: "dir", name: "dir", embedded: false, exported: false, typ: $Uintptr, tag: ""}]);
	imethod.init("internal/reflectlite", [{prop: "name", name: "name", embedded: false, exported: false, typ: nameOff, tag: ""}, {prop: "typ", name: "typ", embedded: false, exported: false, typ: typeOff, tag: ""}]);
	interfaceType.init("internal/reflectlite", [{prop: "rtype", name: "rtype", embedded: true, exported: false, typ: rtype, tag: ""}, {prop: "pkgPath", name: "pkgPath", embedded: false, exported: false, typ: name, tag: ""}, {prop: "methods", name: "methods", embedded: false, exported: false, typ: sliceType$9, tag: ""}]);
	mapType.init("internal/reflectlite", [{prop: "rtype", name: "rtype", embedded: true, exported: false, typ: rtype, tag: ""}, {prop: "key", name: "key", embedded: false, exported: false, typ: ptrType$1, tag: ""}, {prop: "elem", name: "elem", embedded: false, exported: false, typ: ptrType$1, tag: ""}, {prop: "bucket", name: "bucket", embedded: false, exported: false, typ: ptrType$1, tag: ""}, {prop: "hasher", name: "hasher", embedded: false, exported: false, typ: funcType$3, tag: ""}, {prop: "keysize", name: "keysize", embedded: false, exported: false, typ: $Uint8, tag: ""}, {prop: "valuesize", name: "valuesize", embedded: false, exported: false, typ: $Uint8, tag: ""}, {prop: "bucketsize", name: "bucketsize", embedded: false, exported: false, typ: $Uint16, tag: ""}, {prop: "flags", name: "flags", embedded: false, exported: false, typ: $Uint32, tag: ""}]);
	ptrType.init("internal/reflectlite", [{prop: "rtype", name: "rtype", embedded: true, exported: false, typ: rtype, tag: ""}, {prop: "elem", name: "elem", embedded: false, exported: false, typ: ptrType$1, tag: ""}]);
	sliceType.init("internal/reflectlite", [{prop: "rtype", name: "rtype", embedded: true, exported: false, typ: rtype, tag: ""}, {prop: "elem", name: "elem", embedded: false, exported: false, typ: ptrType$1, tag: ""}]);
	structField.init("internal/reflectlite", [{prop: "name", name: "name", embedded: false, exported: false, typ: name, tag: ""}, {prop: "typ", name: "typ", embedded: false, exported: false, typ: ptrType$1, tag: ""}, {prop: "offset", name: "offset", embedded: false, exported: false, typ: $Uintptr, tag: ""}]);
	structType.init("internal/reflectlite", [{prop: "rtype", name: "rtype", embedded: true, exported: false, typ: rtype, tag: ""}, {prop: "pkgPath", name: "pkgPath", embedded: false, exported: false, typ: name, tag: ""}, {prop: "fields", name: "fields", embedded: false, exported: false, typ: sliceType$10, tag: ""}]);
	errorString.init("internal/reflectlite", [{prop: "s", name: "s", embedded: false, exported: false, typ: $String, tag: ""}]);
	Method.init("", [{prop: "Name", name: "Name", embedded: false, exported: true, typ: $String, tag: ""}, {prop: "PkgPath", name: "PkgPath", embedded: false, exported: true, typ: $String, tag: ""}, {prop: "Type", name: "Type", embedded: false, exported: true, typ: Type, tag: ""}, {prop: "Func", name: "Func", embedded: false, exported: true, typ: Value, tag: ""}, {prop: "Index", name: "Index", embedded: false, exported: true, typ: $Int, tag: ""}]);
	uncommonType.init("internal/reflectlite", [{prop: "pkgPath", name: "pkgPath", embedded: false, exported: false, typ: nameOff, tag: ""}, {prop: "mcount", name: "mcount", embedded: false, exported: false, typ: $Uint16, tag: ""}, {prop: "xcount", name: "xcount", embedded: false, exported: false, typ: $Uint16, tag: ""}, {prop: "moff", name: "moff", embedded: false, exported: false, typ: $Uint32, tag: ""}, {prop: "_methods", name: "_methods", embedded: false, exported: false, typ: sliceType$5, tag: ""}]);
	funcType.init("internal/reflectlite", [{prop: "rtype", name: "rtype", embedded: true, exported: false, typ: rtype, tag: "reflect:\"func\""}, {prop: "inCount", name: "inCount", embedded: false, exported: false, typ: $Uint16, tag: ""}, {prop: "outCount", name: "outCount", embedded: false, exported: false, typ: $Uint16, tag: ""}, {prop: "_in", name: "_in", embedded: false, exported: false, typ: sliceType$2, tag: ""}, {prop: "_out", name: "_out", embedded: false, exported: false, typ: sliceType$2, tag: ""}]);
	name.init("internal/reflectlite", [{prop: "bytes", name: "bytes", embedded: false, exported: false, typ: ptrType$6, tag: ""}]);
	nameData.init("internal/reflectlite", [{prop: "name", name: "name", embedded: false, exported: false, typ: $String, tag: ""}, {prop: "tag", name: "tag", embedded: false, exported: false, typ: $String, tag: ""}, {prop: "exported", name: "exported", embedded: false, exported: false, typ: $Bool, tag: ""}, {prop: "embedded", name: "embedded", embedded: false, exported: false, typ: $Bool, tag: ""}]);
	mapIter.init("internal/reflectlite", [{prop: "t", name: "t", embedded: false, exported: false, typ: Type, tag: ""}, {prop: "m", name: "m", embedded: false, exported: false, typ: ptrType$2, tag: ""}, {prop: "keys", name: "keys", embedded: false, exported: false, typ: ptrType$2, tag: ""}, {prop: "i", name: "i", embedded: false, exported: false, typ: $Int, tag: ""}, {prop: "last", name: "last", embedded: false, exported: false, typ: ptrType$2, tag: ""}]);
	TypeEx.init([{prop: "AssignableTo", name: "AssignableTo", pkg: "", typ: $funcType([Type], [$Bool], false)}, {prop: "Comparable", name: "Comparable", pkg: "", typ: $funcType([], [$Bool], false)}, {prop: "Elem", name: "Elem", pkg: "", typ: $funcType([], [Type], false)}, {prop: "Implements", name: "Implements", pkg: "", typ: $funcType([Type], [$Bool], false)}, {prop: "Key", name: "Key", pkg: "", typ: $funcType([], [Type], false)}, {prop: "Kind", name: "Kind", pkg: "", typ: $funcType([], [Kind], false)}, {prop: "Name", name: "Name", pkg: "", typ: $funcType([], [$String], false)}, {prop: "PkgPath", name: "PkgPath", pkg: "", typ: $funcType([], [$String], false)}, {prop: "Size", name: "Size", pkg: "", typ: $funcType([], [$Uintptr], false)}, {prop: "String", name: "String", pkg: "", typ: $funcType([], [$String], false)}, {prop: "common", name: "common", pkg: "internal/reflectlite", typ: $funcType([], [ptrType$1], false)}, {prop: "uncommon", name: "uncommon", pkg: "internal/reflectlite", typ: $funcType([], [ptrType$4], false)}]);
	$init = function() {
		$pkg.$init = function() {};
		/* */ var $f, $c = false, $s = 0, $r; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		$r = js.$init(); /* */ $s = 1; case 1: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = goarch.$init(); /* */ $s = 2; case 2: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		uint8Type = ptrType$1.nil;
		nameOffList = sliceType$1.nil;
		typeOffList = sliceType$2.nil;
		kindNames = new sliceType$3(["invalid", "bool", "int", "int8", "int16", "int32", "int64", "uint", "uint8", "uint16", "uint32", "uint64", "uintptr", "float32", "float64", "complex64", "complex128", "array", "chan", "func", "interface", "map", "ptr", "slice", "string", "struct", "unsafe.Pointer"]);
		callHelper = $assertType($internalize($call, $emptyInterface), funcType$1);
		$pkg.ErrSyntax = new errorString.ptr("invalid syntax");
		initialized = false;
		idJsType = "_jsType";
		idReflectType = "_reflectType";
		idKindType = "kindType";
		idRtype = "_rtype";
		uncommonTypeMap = new $global.Map();
		nameMap = new $global.Map();
		jsObjectPtr = reflectType($jsObjectPtr);
		selectHelper = $assertType($internalize($select, $emptyInterface), funcType$1);
		$r = init(); /* */ $s = 3; case 3: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		/* */ } return; } if ($f === undefined) { $f = { $blk: $init }; } $f.$s = $s; $f.$r = $r; return $f;
	};
	$pkg.$init = $init;
	return $pkg;
})();
$packages["errors"] = (function() {
	var $pkg = {}, $init, reflectlite, errorString, ptrType, ptrType$1, errorType, _r, New;
	reflectlite = $packages["internal/reflectlite"];
	errorString = $pkg.errorString = $newType(0, $kindStruct, "errors.errorString", true, "errors", false, function(s_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.s = "";
			return;
		}
		this.s = s_;
	});
	ptrType = $ptrType($error);
	ptrType$1 = $ptrType(errorString);
	New = function(text) {
		var text;
		return new errorString.ptr(text);
	};
	$pkg.New = New;
	errorString.ptr.prototype.Error = function() {
		var e;
		e = this;
		return e.s;
	};
	errorString.prototype.Error = function() { return this.$val.Error(); };
	ptrType$1.methods = [{prop: "Error", name: "Error", pkg: "", typ: $funcType([], [$String], false)}];
	errorString.init("errors", [{prop: "s", name: "s", embedded: false, exported: false, typ: $String, tag: ""}]);
	$init = function() {
		$pkg.$init = function() {};
		/* */ var $f, $c = false, $s = 0, $r; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		$r = reflectlite.$init(); /* */ $s = 1; case 1: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		_r = reflectlite.TypeOf((ptrType.nil)).Elem(); /* */ $s = 2; case 2: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		errorType = _r;
		/* */ } return; } if ($f === undefined) { $f = { $blk: $init }; } $f.$s = $s; $f.$r = $r; return $f;
	};
	$pkg.$init = $init;
	return $pkg;
})();
$packages["internal/abi"] = (function() {
	var $pkg = {}, $init, goarch, FuncPCABI0;
	goarch = $packages["internal/goarch"];
	FuncPCABI0 = function() {
		$throwRuntimeError("native function not implemented: internal/abi.FuncPCABI0");
	};
	$pkg.FuncPCABI0 = FuncPCABI0;
	$init = function() {
		$pkg.$init = function() {};
		/* */ var $f, $c = false, $s = 0, $r; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		$r = goarch.$init(); /* */ $s = 1; case 1: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		/* */ } return; } if ($f === undefined) { $f = { $blk: $init }; } $f.$s = $s; $f.$r = $r; return $f;
	};
	$pkg.$init = $init;
	return $pkg;
})();
$packages["internal/cpu"] = (function() {
	var $pkg = {}, $init;
	$init = function() {
		$pkg.$init = function() {};
		/* */ var $f, $c = false, $s = 0, $r; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		/* */ } return; } if ($f === undefined) { $f = { $blk: $init }; } $f.$s = $s; $f.$r = $r; return $f;
	};
	$pkg.$init = $init;
	return $pkg;
})();
$packages["internal/bytealg"] = (function() {
	var $pkg = {}, $init, cpu, IndexByteString;
	cpu = $packages["internal/cpu"];
	IndexByteString = function(s, c) {
		var c, i, s;
		i = 0;
		while (true) {
			if (!(i < s.length)) { break; }
			if (s.charCodeAt(i) === c) {
				return i;
			}
			i = i + (1) >> 0;
		}
		return -1;
	};
	$pkg.IndexByteString = IndexByteString;
	$init = function() {
		$pkg.$init = function() {};
		/* */ var $f, $c = false, $s = 0, $r; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		$r = cpu.$init(); /* */ $s = 1; case 1: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		/* */ } return; } if ($f === undefined) { $f = { $blk: $init }; } $f.$s = $s; $f.$r = $r; return $f;
	};
	$pkg.$init = $init;
	return $pkg;
})();
$packages["internal/itoa"] = (function() {
	var $pkg = {}, $init, arrayType, sliceType, Itoa, Uitoa;
	arrayType = $arrayType($Uint8, 20);
	sliceType = $sliceType($Uint8);
	Itoa = function(val) {
		var val;
		if (val < 0) {
			return "-" + Uitoa(((-val >>> 0)));
		}
		return Uitoa(((val >>> 0)));
	};
	$pkg.Itoa = Itoa;
	Uitoa = function(val) {
		var _q, buf, i, q, val;
		if (val === 0) {
			return "0";
		}
		buf = arrayType.zero();
		i = 19;
		while (true) {
			if (!(val >= 10)) { break; }
			q = (_q = val / 10, (_q === _q && _q !== 1/0 && _q !== -1/0) ? _q >>> 0 : $throwRuntimeError("integer divide by zero"));
			((i < 0 || i >= buf.length) ? ($throwRuntimeError("index out of range"), undefined) : buf[i] = ((((48 + val >>> 0) - (q * 10 >>> 0) >>> 0) << 24 >>> 24)));
			i = i - (1) >> 0;
			val = q;
		}
		((i < 0 || i >= buf.length) ? ($throwRuntimeError("index out of range"), undefined) : buf[i] = (((48 + val >>> 0) << 24 >>> 24)));
		return ($bytesToString($subslice(new sliceType(buf), i)));
	};
	$pkg.Uitoa = Uitoa;
	$init = function() {
		$pkg.$init = function() {};
		/* */ var $f, $c = false, $s = 0, $r; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		/* */ } return; } if ($f === undefined) { $f = { $blk: $init }; } $f.$s = $s; $f.$r = $r; return $f;
	};
	$pkg.$init = $init;
	return $pkg;
})();
$packages["internal/unsafeheader"] = (function() {
	var $pkg = {}, $init, Slice;
	Slice = $pkg.Slice = $newType(0, $kindStruct, "unsafeheader.Slice", true, "internal/unsafeheader", true, function(Data_, Len_, Cap_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.Data = 0;
			this.Len = 0;
			this.Cap = 0;
			return;
		}
		this.Data = Data_;
		this.Len = Len_;
		this.Cap = Cap_;
	});
	Slice.init("", [{prop: "Data", name: "Data", embedded: false, exported: true, typ: $UnsafePointer, tag: ""}, {prop: "Len", name: "Len", embedded: false, exported: true, typ: $Int, tag: ""}, {prop: "Cap", name: "Cap", embedded: false, exported: true, typ: $Int, tag: ""}]);
	$init = function() {
		$pkg.$init = function() {};
		/* */ var $f, $c = false, $s = 0, $r; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		/* */ } return; } if ($f === undefined) { $f = { $blk: $init }; } $f.$s = $s; $f.$r = $r; return $f;
	};
	$pkg.$init = $init;
	return $pkg;
})();
$packages["math/bits"] = (function() {
	var $pkg = {}, $init;
	$init = function() {
		$pkg.$init = function() {};
		/* */ var $f, $c = false, $s = 0, $r; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		/* */ } return; } if ($f === undefined) { $f = { $blk: $init }; } $f.$s = $s; $f.$r = $r; return $f;
	};
	$pkg.$init = $init;
	return $pkg;
})();
$packages["math"] = (function() {
	var $pkg = {}, $init, js, bits, arrayType, arrayType$1, arrayType$2, structType, math, nan, buf, init, Float64bits;
	js = $packages["github.com/gopherjs/gopherjs/js"];
	bits = $packages["math/bits"];
	arrayType = $arrayType($Uint32, 2);
	arrayType$1 = $arrayType($Float32, 2);
	arrayType$2 = $arrayType($Float64, 1);
	structType = $structType("math", [{prop: "uint32array", name: "uint32array", embedded: false, exported: false, typ: arrayType, tag: ""}, {prop: "float32array", name: "float32array", embedded: false, exported: false, typ: arrayType$1, tag: ""}, {prop: "float64array", name: "float64array", embedded: false, exported: false, typ: arrayType$2, tag: ""}]);
	init = function() {
		var ab;
		ab = new ($global.ArrayBuffer)(8);
		buf.uint32array = new ($global.Uint32Array)(ab);
		buf.float32array = new ($global.Float32Array)(ab);
		buf.float64array = new ($global.Float64Array)(ab);
	};
	Float64bits = function(f) {
		var f, x, x$1;
		buf.float64array[0] = f;
		return (x = $shiftLeft64((new $Uint64(0, buf.uint32array[1])), 32), x$1 = (new $Uint64(0, buf.uint32array[0])), new $Uint64(x.$high + x$1.$high, x.$low + x$1.$low));
	};
	$pkg.Float64bits = Float64bits;
	$init = function() {
		$pkg.$init = function() {};
		/* */ var $f, $c = false, $s = 0, $r; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		$r = js.$init(); /* */ $s = 1; case 1: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = bits.$init(); /* */ $s = 2; case 2: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		buf = new structType.ptr(arrayType.zero(), arrayType$1.zero(), arrayType$2.zero());
		math = $global.Math;
		nan = $parseFloat($NaN);
		init();
		/* */ } return; } if ($f === undefined) { $f = { $blk: $init }; } $f.$s = $s; $f.$r = $r; return $f;
	};
	$pkg.$init = $init;
	return $pkg;
})();
$packages["unicode/utf8"] = (function() {
	var $pkg = {}, $init, acceptRange, first, acceptRanges, DecodeRuneInString, EncodeRune, ValidString, ValidRune;
	acceptRange = $pkg.acceptRange = $newType(0, $kindStruct, "utf8.acceptRange", true, "unicode/utf8", false, function(lo_, hi_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.lo = 0;
			this.hi = 0;
			return;
		}
		this.lo = lo_;
		this.hi = hi_;
	});
	DecodeRuneInString = function(s) {
		var _tmp, _tmp$1, _tmp$10, _tmp$11, _tmp$12, _tmp$13, _tmp$14, _tmp$15, _tmp$16, _tmp$17, _tmp$2, _tmp$3, _tmp$4, _tmp$5, _tmp$6, _tmp$7, _tmp$8, _tmp$9, accept, mask, n, r, s, s0, s1, s2, s3, size, sz, x, x$1;
		r = 0;
		size = 0;
		n = s.length;
		if (n < 1) {
			_tmp = 65533;
			_tmp$1 = 0;
			r = _tmp;
			size = _tmp$1;
			return [r, size];
		}
		s0 = s.charCodeAt(0);
		x = ((s0 < 0 || s0 >= first.length) ? ($throwRuntimeError("index out of range"), undefined) : first[s0]);
		if (x >= 240) {
			mask = (((x >> 0)) << 31 >> 0) >> 31 >> 0;
			_tmp$2 = ((((s.charCodeAt(0) >> 0)) & ~mask) >> 0) | (65533 & mask);
			_tmp$3 = 1;
			r = _tmp$2;
			size = _tmp$3;
			return [r, size];
		}
		sz = ((((x & 7) >>> 0) >> 0));
		accept = $clone((x$1 = x >>> 4 << 24 >>> 24, ((x$1 < 0 || x$1 >= acceptRanges.length) ? ($throwRuntimeError("index out of range"), undefined) : acceptRanges[x$1])), acceptRange);
		if (n < sz) {
			_tmp$4 = 65533;
			_tmp$5 = 1;
			r = _tmp$4;
			size = _tmp$5;
			return [r, size];
		}
		s1 = s.charCodeAt(1);
		if (s1 < accept.lo || accept.hi < s1) {
			_tmp$6 = 65533;
			_tmp$7 = 1;
			r = _tmp$6;
			size = _tmp$7;
			return [r, size];
		}
		if (sz <= 2) {
			_tmp$8 = (((((s0 & 31) >>> 0) >> 0)) << 6 >> 0) | ((((s1 & 63) >>> 0) >> 0));
			_tmp$9 = 2;
			r = _tmp$8;
			size = _tmp$9;
			return [r, size];
		}
		s2 = s.charCodeAt(2);
		if (s2 < 128 || 191 < s2) {
			_tmp$10 = 65533;
			_tmp$11 = 1;
			r = _tmp$10;
			size = _tmp$11;
			return [r, size];
		}
		if (sz <= 3) {
			_tmp$12 = ((((((s0 & 15) >>> 0) >> 0)) << 12 >> 0) | (((((s1 & 63) >>> 0) >> 0)) << 6 >> 0)) | ((((s2 & 63) >>> 0) >> 0));
			_tmp$13 = 3;
			r = _tmp$12;
			size = _tmp$13;
			return [r, size];
		}
		s3 = s.charCodeAt(3);
		if (s3 < 128 || 191 < s3) {
			_tmp$14 = 65533;
			_tmp$15 = 1;
			r = _tmp$14;
			size = _tmp$15;
			return [r, size];
		}
		_tmp$16 = (((((((s0 & 7) >>> 0) >> 0)) << 18 >> 0) | (((((s1 & 63) >>> 0) >> 0)) << 12 >> 0)) | (((((s2 & 63) >>> 0) >> 0)) << 6 >> 0)) | ((((s3 & 63) >>> 0) >> 0));
		_tmp$17 = 4;
		r = _tmp$16;
		size = _tmp$17;
		return [r, size];
	};
	$pkg.DecodeRuneInString = DecodeRuneInString;
	EncodeRune = function(p, r) {
		var i, p, r;
		i = ((r >>> 0));
		if (i <= 127) {
			(0 >= p.$length ? ($throwRuntimeError("index out of range"), undefined) : p.$array[p.$offset + 0] = ((r << 24 >>> 24)));
			return 1;
		} else if (i <= 2047) {
			$unused((1 >= p.$length ? ($throwRuntimeError("index out of range"), undefined) : p.$array[p.$offset + 1]));
			(0 >= p.$length ? ($throwRuntimeError("index out of range"), undefined) : p.$array[p.$offset + 0] = ((192 | (((r >> 6 >> 0) << 24 >>> 24))) >>> 0));
			(1 >= p.$length ? ($throwRuntimeError("index out of range"), undefined) : p.$array[p.$offset + 1] = ((128 | ((((r << 24 >>> 24)) & 63) >>> 0)) >>> 0));
			return 2;
		} else if ((i > 1114111) || (55296 <= i && i <= 57343)) {
			r = 65533;
			$unused((2 >= p.$length ? ($throwRuntimeError("index out of range"), undefined) : p.$array[p.$offset + 2]));
			(0 >= p.$length ? ($throwRuntimeError("index out of range"), undefined) : p.$array[p.$offset + 0] = ((224 | (((r >> 12 >> 0) << 24 >>> 24))) >>> 0));
			(1 >= p.$length ? ($throwRuntimeError("index out of range"), undefined) : p.$array[p.$offset + 1] = ((128 | (((((r >> 6 >> 0) << 24 >>> 24)) & 63) >>> 0)) >>> 0));
			(2 >= p.$length ? ($throwRuntimeError("index out of range"), undefined) : p.$array[p.$offset + 2] = ((128 | ((((r << 24 >>> 24)) & 63) >>> 0)) >>> 0));
			return 3;
		} else if (i <= 65535) {
			$unused((2 >= p.$length ? ($throwRuntimeError("index out of range"), undefined) : p.$array[p.$offset + 2]));
			(0 >= p.$length ? ($throwRuntimeError("index out of range"), undefined) : p.$array[p.$offset + 0] = ((224 | (((r >> 12 >> 0) << 24 >>> 24))) >>> 0));
			(1 >= p.$length ? ($throwRuntimeError("index out of range"), undefined) : p.$array[p.$offset + 1] = ((128 | (((((r >> 6 >> 0) << 24 >>> 24)) & 63) >>> 0)) >>> 0));
			(2 >= p.$length ? ($throwRuntimeError("index out of range"), undefined) : p.$array[p.$offset + 2] = ((128 | ((((r << 24 >>> 24)) & 63) >>> 0)) >>> 0));
			return 3;
		} else {
			$unused((3 >= p.$length ? ($throwRuntimeError("index out of range"), undefined) : p.$array[p.$offset + 3]));
			(0 >= p.$length ? ($throwRuntimeError("index out of range"), undefined) : p.$array[p.$offset + 0] = ((240 | (((r >> 18 >> 0) << 24 >>> 24))) >>> 0));
			(1 >= p.$length ? ($throwRuntimeError("index out of range"), undefined) : p.$array[p.$offset + 1] = ((128 | (((((r >> 12 >> 0) << 24 >>> 24)) & 63) >>> 0)) >>> 0));
			(2 >= p.$length ? ($throwRuntimeError("index out of range"), undefined) : p.$array[p.$offset + 2] = ((128 | (((((r >> 6 >> 0) << 24 >>> 24)) & 63) >>> 0)) >>> 0));
			(3 >= p.$length ? ($throwRuntimeError("index out of range"), undefined) : p.$array[p.$offset + 3] = ((128 | ((((r << 24 >>> 24)) & 63) >>> 0)) >>> 0));
			return 4;
		}
	};
	$pkg.EncodeRune = EncodeRune;
	ValidString = function(s) {
		var accept, c, c$1, c$2, first32, i, n, s, second32, si, size, x, x$1;
		while (true) {
			if (!(s.length >= 8)) { break; }
			first32 = (((((((s.charCodeAt(0) >>> 0)) | (((s.charCodeAt(1) >>> 0)) << 8 >>> 0)) >>> 0) | (((s.charCodeAt(2) >>> 0)) << 16 >>> 0)) >>> 0) | (((s.charCodeAt(3) >>> 0)) << 24 >>> 0)) >>> 0;
			second32 = (((((((s.charCodeAt(4) >>> 0)) | (((s.charCodeAt(5) >>> 0)) << 8 >>> 0)) >>> 0) | (((s.charCodeAt(6) >>> 0)) << 16 >>> 0)) >>> 0) | (((s.charCodeAt(7) >>> 0)) << 24 >>> 0)) >>> 0;
			if (!(((((((first32 | second32) >>> 0)) & 2155905152) >>> 0) === 0))) {
				break;
			}
			s = $substring(s, 8);
		}
		n = s.length;
		i = 0;
		while (true) {
			if (!(i < n)) { break; }
			si = s.charCodeAt(i);
			if (si < 128) {
				i = i + (1) >> 0;
				continue;
			}
			x = ((si < 0 || si >= first.length) ? ($throwRuntimeError("index out of range"), undefined) : first[si]);
			if (x === 241) {
				return false;
			}
			size = ((((x & 7) >>> 0) >> 0));
			if ((i + size >> 0) > n) {
				return false;
			}
			accept = $clone((x$1 = x >>> 4 << 24 >>> 24, ((x$1 < 0 || x$1 >= acceptRanges.length) ? ($throwRuntimeError("index out of range"), undefined) : acceptRanges[x$1])), acceptRange);
			c = s.charCodeAt((i + 1 >> 0));
			if (c < accept.lo || accept.hi < c) {
				return false;
			} else if (size === 2) {
			} else {
				c$1 = s.charCodeAt((i + 2 >> 0));
				if (c$1 < 128 || 191 < c$1) {
					return false;
				} else if (size === 3) {
				} else {
					c$2 = s.charCodeAt((i + 3 >> 0));
					if (c$2 < 128 || 191 < c$2) {
						return false;
					}
				}
			}
			i = i + (size) >> 0;
		}
		return true;
	};
	$pkg.ValidString = ValidString;
	ValidRune = function(r) {
		var r;
		if (0 <= r && r < 55296) {
			return true;
		} else if (57343 < r && r <= 1114111) {
			return true;
		}
		return false;
	};
	$pkg.ValidRune = ValidRune;
	acceptRange.init("unicode/utf8", [{prop: "lo", name: "lo", embedded: false, exported: false, typ: $Uint8, tag: ""}, {prop: "hi", name: "hi", embedded: false, exported: false, typ: $Uint8, tag: ""}]);
	$init = function() {
		$pkg.$init = function() {};
		/* */ var $f, $c = false, $s = 0, $r; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		first = $toNativeArray($kindUint8, [240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 19, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 35, 3, 3, 52, 4, 4, 4, 68, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241]);
		acceptRanges = $toNativeArray($kindStruct, [$clone(new acceptRange.ptr(128, 191), acceptRange), $clone(new acceptRange.ptr(160, 191), acceptRange), $clone(new acceptRange.ptr(128, 159), acceptRange), $clone(new acceptRange.ptr(144, 191), acceptRange), $clone(new acceptRange.ptr(128, 143), acceptRange), new acceptRange.ptr(0, 0), new acceptRange.ptr(0, 0), new acceptRange.ptr(0, 0), new acceptRange.ptr(0, 0), new acceptRange.ptr(0, 0), new acceptRange.ptr(0, 0), new acceptRange.ptr(0, 0), new acceptRange.ptr(0, 0), new acceptRange.ptr(0, 0), new acceptRange.ptr(0, 0), new acceptRange.ptr(0, 0)]);
		/* */ } return; } if ($f === undefined) { $f = { $blk: $init }; } $f.$s = $s; $f.$r = $r; return $f;
	};
	$pkg.$init = $init;
	return $pkg;
})();
$packages["strconv"] = (function() {
	var $pkg = {}, $init, errors, js, bytealg, math, bits, utf8, sliceType$6, arrayType$1, contains, unhex, UnquoteChar, Unquote, unquote, Itoa, index;
	errors = $packages["errors"];
	js = $packages["github.com/gopherjs/gopherjs/js"];
	bytealg = $packages["internal/bytealg"];
	math = $packages["math"];
	bits = $packages["math/bits"];
	utf8 = $packages["unicode/utf8"];
	sliceType$6 = $sliceType($Uint8);
	arrayType$1 = $arrayType($Uint8, 4);
	contains = function(s, c) {
		var c, s;
		return !((index(s, c) === -1));
	};
	unhex = function(b) {
		var _tmp, _tmp$1, _tmp$2, _tmp$3, _tmp$4, _tmp$5, b, c, ok, v;
		v = 0;
		ok = false;
		c = ((b >> 0));
		if (48 <= c && c <= 57) {
			_tmp = c - 48 >> 0;
			_tmp$1 = true;
			v = _tmp;
			ok = _tmp$1;
			return [v, ok];
		} else if (97 <= c && c <= 102) {
			_tmp$2 = (c - 97 >> 0) + 10 >> 0;
			_tmp$3 = true;
			v = _tmp$2;
			ok = _tmp$3;
			return [v, ok];
		} else if (65 <= c && c <= 70) {
			_tmp$4 = (c - 65 >> 0) + 10 >> 0;
			_tmp$5 = true;
			v = _tmp$4;
			ok = _tmp$5;
			return [v, ok];
		}
		return [v, ok];
	};
	UnquoteChar = function(s, quote) {
		var _1, _2, _tmp, _tmp$1, _tmp$2, _tmp$3, _tmp$4, _tmp$5, _tmp$6, _tmp$7, _tuple, _tuple$1, c, c$1, err, j, j$1, multibyte, n, ok, quote, r, s, size, tail, v, v$1, value, x, x$1;
		value = 0;
		multibyte = false;
		tail = "";
		err = $ifaceNil;
		if (s.length === 0) {
			err = $pkg.ErrSyntax;
			return [value, multibyte, tail, err];
		}
		c = s.charCodeAt(0);
		if ((c === quote) && ((quote === 39) || (quote === 34))) {
			err = $pkg.ErrSyntax;
			return [value, multibyte, tail, err];
		} else if (c >= 128) {
			_tuple = utf8.DecodeRuneInString(s);
			r = _tuple[0];
			size = _tuple[1];
			_tmp = r;
			_tmp$1 = true;
			_tmp$2 = $substring(s, size);
			_tmp$3 = $ifaceNil;
			value = _tmp;
			multibyte = _tmp$1;
			tail = _tmp$2;
			err = _tmp$3;
			return [value, multibyte, tail, err];
		} else if (!((c === 92))) {
			_tmp$4 = ((s.charCodeAt(0) >> 0));
			_tmp$5 = false;
			_tmp$6 = $substring(s, 1);
			_tmp$7 = $ifaceNil;
			value = _tmp$4;
			multibyte = _tmp$5;
			tail = _tmp$6;
			err = _tmp$7;
			return [value, multibyte, tail, err];
		}
		if (s.length <= 1) {
			err = $pkg.ErrSyntax;
			return [value, multibyte, tail, err];
		}
		c$1 = s.charCodeAt(1);
		s = $substring(s, 2);
		switch (0) { default:
			_1 = c$1;
			if (_1 === (97)) {
				value = 7;
			} else if (_1 === (98)) {
				value = 8;
			} else if (_1 === (102)) {
				value = 12;
			} else if (_1 === (110)) {
				value = 10;
			} else if (_1 === (114)) {
				value = 13;
			} else if (_1 === (116)) {
				value = 9;
			} else if (_1 === (118)) {
				value = 11;
			} else if ((_1 === (120)) || (_1 === (117)) || (_1 === (85))) {
				n = 0;
				_2 = c$1;
				if (_2 === (120)) {
					n = 2;
				} else if (_2 === (117)) {
					n = 4;
				} else if (_2 === (85)) {
					n = 8;
				}
				v = 0;
				if (s.length < n) {
					err = $pkg.ErrSyntax;
					return [value, multibyte, tail, err];
				}
				j = 0;
				while (true) {
					if (!(j < n)) { break; }
					_tuple$1 = unhex(s.charCodeAt(j));
					x = _tuple$1[0];
					ok = _tuple$1[1];
					if (!ok) {
						err = $pkg.ErrSyntax;
						return [value, multibyte, tail, err];
					}
					v = (v << 4 >> 0) | x;
					j = j + (1) >> 0;
				}
				s = $substring(s, n);
				if (c$1 === 120) {
					value = v;
					break;
				}
				if (!utf8.ValidRune(v)) {
					err = $pkg.ErrSyntax;
					return [value, multibyte, tail, err];
				}
				value = v;
				multibyte = true;
			} else if ((_1 === (48)) || (_1 === (49)) || (_1 === (50)) || (_1 === (51)) || (_1 === (52)) || (_1 === (53)) || (_1 === (54)) || (_1 === (55))) {
				v$1 = ((c$1 >> 0)) - 48 >> 0;
				if (s.length < 2) {
					err = $pkg.ErrSyntax;
					return [value, multibyte, tail, err];
				}
				j$1 = 0;
				while (true) {
					if (!(j$1 < 2)) { break; }
					x$1 = ((s.charCodeAt(j$1) >> 0)) - 48 >> 0;
					if (x$1 < 0 || x$1 > 7) {
						err = $pkg.ErrSyntax;
						return [value, multibyte, tail, err];
					}
					v$1 = ((v$1 << 3 >> 0)) | x$1;
					j$1 = j$1 + (1) >> 0;
				}
				s = $substring(s, 2);
				if (v$1 > 255) {
					err = $pkg.ErrSyntax;
					return [value, multibyte, tail, err];
				}
				value = v$1;
			} else if (_1 === (92)) {
				value = 92;
			} else if ((_1 === (39)) || (_1 === (34))) {
				if (!((c$1 === quote))) {
					err = $pkg.ErrSyntax;
					return [value, multibyte, tail, err];
				}
				value = ((c$1 >> 0));
			} else {
				err = $pkg.ErrSyntax;
				return [value, multibyte, tail, err];
			}
		}
		tail = s;
		return [value, multibyte, tail, err];
	};
	$pkg.UnquoteChar = UnquoteChar;
	Unquote = function(s) {
		var _tuple, err, out, rem, s;
		_tuple = unquote(s, true);
		out = _tuple[0];
		rem = _tuple[1];
		err = _tuple[2];
		if (rem.length > 0) {
			return ["", $pkg.ErrSyntax];
		}
		return [out, err];
	};
	$pkg.Unquote = Unquote;
	unquote = function(in$1, unescape) {
		var _1, _2, _q, _tmp, _tmp$1, _tmp$10, _tmp$11, _tmp$12, _tmp$13, _tmp$14, _tmp$15, _tmp$16, _tmp$17, _tmp$18, _tmp$19, _tmp$2, _tmp$20, _tmp$21, _tmp$22, _tmp$23, _tmp$24, _tmp$25, _tmp$26, _tmp$3, _tmp$4, _tmp$5, _tmp$6, _tmp$7, _tmp$8, _tmp$9, _tuple, _tuple$1, arr, buf, buf$1, end, err, err$1, i, in$1, in0, multibyte, n, n$1, out, quote, r, r$1, rem, rem$1, unescape, valid;
		out = "";
		rem = "";
		err = $ifaceNil;
		if (in$1.length < 2) {
			_tmp = "";
			_tmp$1 = in$1;
			_tmp$2 = $pkg.ErrSyntax;
			out = _tmp;
			rem = _tmp$1;
			err = _tmp$2;
			return [out, rem, err];
		}
		quote = in$1.charCodeAt(0);
		end = index($substring(in$1, 1), quote);
		if (end < 0) {
			_tmp$3 = "";
			_tmp$4 = in$1;
			_tmp$5 = $pkg.ErrSyntax;
			out = _tmp$3;
			rem = _tmp$4;
			err = _tmp$5;
			return [out, rem, err];
		}
		end = end + (2) >> 0;
		_1 = quote;
		if (_1 === (96)) {
			if (!unescape) {
				out = $substring(in$1, 0, end);
			} else if (!contains($substring(in$1, 0, end), 13)) {
				out = $substring(in$1, 1, (end - 1 >> 0));
			} else {
				buf = $makeSlice(sliceType$6, 0, (((end - 1 >> 0) - 1 >> 0) - 1 >> 0));
				i = 1;
				while (true) {
					if (!(i < (end - 1 >> 0))) { break; }
					if (!((in$1.charCodeAt(i) === 13))) {
						buf = $append(buf, in$1.charCodeAt(i));
					}
					i = i + (1) >> 0;
				}
				out = ($bytesToString(buf));
			}
			_tmp$6 = out;
			_tmp$7 = $substring(in$1, end);
			_tmp$8 = $ifaceNil;
			out = _tmp$6;
			rem = _tmp$7;
			err = _tmp$8;
			return [out, rem, err];
		} else if ((_1 === (34)) || (_1 === (39))) {
			if (!contains($substring(in$1, 0, end), 92) && !contains($substring(in$1, 0, end), 10)) {
				valid = false;
				_2 = quote;
				if (_2 === (34)) {
					valid = utf8.ValidString($substring(in$1, 1, (end - 1 >> 0)));
				} else if (_2 === (39)) {
					_tuple = utf8.DecodeRuneInString($substring(in$1, 1, (end - 1 >> 0)));
					r = _tuple[0];
					n = _tuple[1];
					valid = (((1 + n >> 0) + 1 >> 0) === end) && (!((r === 65533)) || !((n === 1)));
				}
				if (valid) {
					out = $substring(in$1, 0, end);
					if (unescape) {
						out = $substring(out, 1, (end - 1 >> 0));
					}
					_tmp$9 = out;
					_tmp$10 = $substring(in$1, end);
					_tmp$11 = $ifaceNil;
					out = _tmp$9;
					rem = _tmp$10;
					err = _tmp$11;
					return [out, rem, err];
				}
			}
			buf$1 = sliceType$6.nil;
			in0 = in$1;
			in$1 = $substring(in$1, 1);
			if (unescape) {
				buf$1 = $makeSlice(sliceType$6, 0, (_q = ($imul(3, end)) / 2, (_q === _q && _q !== 1/0 && _q !== -1/0) ? _q >> 0 : $throwRuntimeError("integer divide by zero")));
			}
			while (true) {
				if (!(in$1.length > 0 && !((in$1.charCodeAt(0) === quote)))) { break; }
				_tuple$1 = UnquoteChar(in$1, quote);
				r$1 = _tuple$1[0];
				multibyte = _tuple$1[1];
				rem$1 = _tuple$1[2];
				err$1 = _tuple$1[3];
				if ((in$1.charCodeAt(0) === 10) || !($interfaceIsEqual(err$1, $ifaceNil))) {
					_tmp$12 = "";
					_tmp$13 = in0;
					_tmp$14 = $pkg.ErrSyntax;
					out = _tmp$12;
					rem = _tmp$13;
					err = _tmp$14;
					return [out, rem, err];
				}
				in$1 = rem$1;
				if (unescape) {
					if (r$1 < 128 || !multibyte) {
						buf$1 = $append(buf$1, ((r$1 << 24 >>> 24)));
					} else {
						arr = arrayType$1.zero();
						n$1 = utf8.EncodeRune(new sliceType$6(arr), r$1);
						buf$1 = $appendSlice(buf$1, $subslice(new sliceType$6(arr), 0, n$1));
					}
				}
				if (quote === 39) {
					break;
				}
			}
			if (!(in$1.length > 0 && (in$1.charCodeAt(0) === quote))) {
				_tmp$15 = "";
				_tmp$16 = in0;
				_tmp$17 = $pkg.ErrSyntax;
				out = _tmp$15;
				rem = _tmp$16;
				err = _tmp$17;
				return [out, rem, err];
			}
			in$1 = $substring(in$1, 1);
			if (unescape) {
				_tmp$18 = ($bytesToString(buf$1));
				_tmp$19 = in$1;
				_tmp$20 = $ifaceNil;
				out = _tmp$18;
				rem = _tmp$19;
				err = _tmp$20;
				return [out, rem, err];
			}
			_tmp$21 = $substring(in0, 0, (in0.length - in$1.length >> 0));
			_tmp$22 = in$1;
			_tmp$23 = $ifaceNil;
			out = _tmp$21;
			rem = _tmp$22;
			err = _tmp$23;
			return [out, rem, err];
		} else {
			_tmp$24 = "";
			_tmp$25 = in$1;
			_tmp$26 = $pkg.ErrSyntax;
			out = _tmp$24;
			rem = _tmp$25;
			err = _tmp$26;
			return [out, rem, err];
		}
	};
	Itoa = function(i) {
		var i;
		return $internalize(i.toString(), $String);
	};
	$pkg.Itoa = Itoa;
	index = function(s, c) {
		var c, s;
		return bytealg.IndexByteString(s, c);
	};
	$init = function() {
		$pkg.$init = function() {};
		/* */ var $f, $c = false, $s = 0, $r; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		$r = errors.$init(); /* */ $s = 1; case 1: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = js.$init(); /* */ $s = 2; case 2: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = bytealg.$init(); /* */ $s = 3; case 3: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = math.$init(); /* */ $s = 4; case 4: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = bits.$init(); /* */ $s = 5; case 5: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = utf8.$init(); /* */ $s = 6; case 6: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$pkg.ErrRange = errors.New("value out of range");
		$pkg.ErrSyntax = errors.New("invalid syntax");
		/* */ } return; } if ($f === undefined) { $f = { $blk: $init }; } $f.$s = $s; $f.$r = $r; return $f;
	};
	$pkg.$init = $init;
	return $pkg;
})();
$packages["internal/race"] = (function() {
	var $pkg = {}, $init;
	$init = function() {
		$pkg.$init = function() {};
		/* */ var $f, $c = false, $s = 0, $r; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		/* */ } return; } if ($f === undefined) { $f = { $blk: $init }; } $f.$s = $s; $f.$r = $r; return $f;
	};
	$pkg.$init = $init;
	return $pkg;
})();
$packages["sync/atomic"] = (function() {
	var $pkg = {}, $init, js;
	js = $packages["github.com/gopherjs/gopherjs/js"];
	$init = function() {
		$pkg.$init = function() {};
		/* */ var $f, $c = false, $s = 0, $r; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		$r = js.$init(); /* */ $s = 1; case 1: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		/* */ } return; } if ($f === undefined) { $f = { $blk: $init }; } $f.$s = $s; $f.$r = $r; return $f;
	};
	$pkg.$init = $init;
	return $pkg;
})();
$packages["sync"] = (function() {
	var $pkg = {}, $init, js, race, atomic, notifyList, expunged, semWaiters, semAwoken, init, runtime_notifyListCheck;
	js = $packages["github.com/gopherjs/gopherjs/js"];
	race = $packages["internal/race"];
	atomic = $packages["sync/atomic"];
	notifyList = $pkg.notifyList = $newType(0, $kindStruct, "sync.notifyList", true, "sync", false, function(wait_, notify_, lock_, head_, tail_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.wait = 0;
			this.notify = 0;
			this.lock = 0;
			this.head = 0;
			this.tail = 0;
			return;
		}
		this.wait = wait_;
		this.notify = notify_;
		this.lock = lock_;
		this.head = head_;
		this.tail = tail_;
	});
	init = function() {
		var n;
		n = new notifyList.ptr(0, 0, 0, 0, 0);
		runtime_notifyListCheck(20);
	};
	runtime_notifyListCheck = function(size) {
		var size;
	};
	notifyList.init("sync", [{prop: "wait", name: "wait", embedded: false, exported: false, typ: $Uint32, tag: ""}, {prop: "notify", name: "notify", embedded: false, exported: false, typ: $Uint32, tag: ""}, {prop: "lock", name: "lock", embedded: false, exported: false, typ: $Uintptr, tag: ""}, {prop: "head", name: "head", embedded: false, exported: false, typ: $UnsafePointer, tag: ""}, {prop: "tail", name: "tail", embedded: false, exported: false, typ: $UnsafePointer, tag: ""}]);
	$init = function() {
		$pkg.$init = function() {};
		/* */ var $f, $c = false, $s = 0, $r; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		$r = js.$init(); /* */ $s = 1; case 1: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = race.$init(); /* */ $s = 2; case 2: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = atomic.$init(); /* */ $s = 3; case 3: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		expunged = (new Uint8Array(8));
		semWaiters = new $global.Map();
		semAwoken = new $global.Map();
		init();
		/* */ } return; } if ($f === undefined) { $f = { $blk: $init }; } $f.$s = $s; $f.$r = $r; return $f;
	};
	$pkg.$init = $init;
	return $pkg;
})();
$packages["unicode"] = (function() {
	var $pkg = {}, $init;
	$init = function() {
		$pkg.$init = function() {};
		/* */ var $f, $c = false, $s = 0, $r; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		/* */ } return; } if ($f === undefined) { $f = { $blk: $init }; } $f.$s = $s; $f.$r = $r; return $f;
	};
	$pkg.$init = $init;
	return $pkg;
})();
$packages["reflect"] = (function() {
	var $pkg = {}, $init, errors, js, abi, bytealg, goarch, itoa, unsafeheader, math, runtime, strconv, sync, unicode, utf8, Value, flag, ValueError, MapIter, Type, Kind, tflag, rtype, method, ChanDir, arrayType, chanType, imethod, interfaceType, mapType, ptrType, sliceType, structField, structType, Method, nameOff, typeOff, textOff, StructField, StructTag, fieldScan, uncommonType, funcType, name, nameData, hiter, sliceType$1, ptrType$1, sliceType$2, sliceType$3, sliceType$4, sliceType$5, ptrType$2, funcType$1, sliceType$7, sliceType$8, ptrType$6, ptrType$8, ptrType$9, sliceType$10, ptrType$10, sliceType$11, ptrType$11, ptrType$12, sliceType$12, ptrType$13, ptrType$14, funcType$2, sliceType$14, sliceType$15, ptrType$18, structType$3, sliceType$16, ptrType$19, ptrType$20, sliceType$17, sliceType$18, arrayType$7, sliceType$20, funcType$3, ptrType$23, arrayType$8, ptrType$24, funcType$4, funcType$5, ptrType$26, ptrType$27, bytesType, uint8Type, stringType, kindNames, initialized, nameMap, nameOffList, typeOffList, callHelper, jsObjectPtr, selectHelper, copyVal, overflowFloat32, convertOp, makeFloat, makeFloat32, makeComplex, makeString, makeBytes, makeRunes, cvtInt, cvtUint, cvtFloatInt, cvtFloatUint, cvtIntFloat, cvtUintFloat, cvtFloat, cvtComplex, cvtIntString, cvtUintString, cvtBytesString, cvtStringBytes, cvtRunesString, cvtStringRunes, cvtT2I, cvtI2I, PtrTo, PointerTo, implements$1, specialChannelAssignability, directlyAssignable, haveIdenticalType, haveIdenticalUnderlyingType, toType, ifaceIndir, methodValueCallCodePtr, methodValueCall, init, New, jsType, reflectType, setKindType, newName, newMethodName, resolveReflectName, newTypeOff, internalStr, isWrapped, copyStruct, makeValue, MakeSlice, TypeOf, ValueOf, FuncOf, SliceOf, Zero, unsafe_New, makeInt, typedmemmove, keyFor, mapaccess, mapassign, mapdelete, mapaccess_faststr, mapassign_faststr, mapdelete_faststr, mapiterinit, mapiterkey, mapiterelem, mapiternext, maplen, cvtDirect, cvtSliceArrayPtr, methodReceiver, valueInterface, ifaceE2I, makeMethodValue, wrapJsObject, unwrapJsObject, getJsTag, chanrecv, chansend, stringsLastIndex, stringsHasPrefix, valueMethodName, verifyNotInHeapPtr;
	errors = $packages["errors"];
	js = $packages["github.com/gopherjs/gopherjs/js"];
	abi = $packages["internal/abi"];
	bytealg = $packages["internal/bytealg"];
	goarch = $packages["internal/goarch"];
	itoa = $packages["internal/itoa"];
	unsafeheader = $packages["internal/unsafeheader"];
	math = $packages["math"];
	runtime = $packages["runtime"];
	strconv = $packages["strconv"];
	sync = $packages["sync"];
	unicode = $packages["unicode"];
	utf8 = $packages["unicode/utf8"];
	Value = $pkg.Value = $newType(0, $kindStruct, "reflect.Value", true, "reflect", true, function(typ_, ptr_, flag_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.typ = ptrType$1.nil;
			this.ptr = 0;
			this.flag = 0;
			return;
		}
		this.typ = typ_;
		this.ptr = ptr_;
		this.flag = flag_;
	});
	flag = $pkg.flag = $newType(4, $kindUintptr, "reflect.flag", true, "reflect", false, null);
	ValueError = $pkg.ValueError = $newType(0, $kindStruct, "reflect.ValueError", true, "reflect", true, function(Method_, Kind_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.Method = "";
			this.Kind = 0;
			return;
		}
		this.Method = Method_;
		this.Kind = Kind_;
	});
	MapIter = $pkg.MapIter = $newType(0, $kindStruct, "reflect.MapIter", true, "reflect", true, function(m_, hiter_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.m = new Value.ptr(ptrType$1.nil, 0, 0);
			this.hiter = new hiter.ptr($ifaceNil, null, null, 0, null);
			return;
		}
		this.m = m_;
		this.hiter = hiter_;
	});
	Type = $pkg.Type = $newType(8, $kindInterface, "reflect.Type", true, "reflect", true, null);
	Kind = $pkg.Kind = $newType(4, $kindUint, "reflect.Kind", true, "reflect", true, null);
	tflag = $pkg.tflag = $newType(1, $kindUint8, "reflect.tflag", true, "reflect", false, null);
	rtype = $pkg.rtype = $newType(0, $kindStruct, "reflect.rtype", true, "reflect", false, function(size_, ptrdata_, hash_, tflag_, align_, fieldAlign_, kind_, equal_, gcdata_, str_, ptrToThis_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.size = 0;
			this.ptrdata = 0;
			this.hash = 0;
			this.tflag = 0;
			this.align = 0;
			this.fieldAlign = 0;
			this.kind = 0;
			this.equal = $throwNilPointerError;
			this.gcdata = ptrType$14.nil;
			this.str = 0;
			this.ptrToThis = 0;
			return;
		}
		this.size = size_;
		this.ptrdata = ptrdata_;
		this.hash = hash_;
		this.tflag = tflag_;
		this.align = align_;
		this.fieldAlign = fieldAlign_;
		this.kind = kind_;
		this.equal = equal_;
		this.gcdata = gcdata_;
		this.str = str_;
		this.ptrToThis = ptrToThis_;
	});
	method = $pkg.method = $newType(0, $kindStruct, "reflect.method", true, "reflect", false, function(name_, mtyp_, ifn_, tfn_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.name = 0;
			this.mtyp = 0;
			this.ifn = 0;
			this.tfn = 0;
			return;
		}
		this.name = name_;
		this.mtyp = mtyp_;
		this.ifn = ifn_;
		this.tfn = tfn_;
	});
	ChanDir = $pkg.ChanDir = $newType(4, $kindInt, "reflect.ChanDir", true, "reflect", true, null);
	arrayType = $pkg.arrayType = $newType(0, $kindStruct, "reflect.arrayType", true, "reflect", false, function(rtype_, elem_, slice_, len_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.rtype = new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$14.nil, 0, 0);
			this.elem = ptrType$1.nil;
			this.slice = ptrType$1.nil;
			this.len = 0;
			return;
		}
		this.rtype = rtype_;
		this.elem = elem_;
		this.slice = slice_;
		this.len = len_;
	});
	chanType = $pkg.chanType = $newType(0, $kindStruct, "reflect.chanType", true, "reflect", false, function(rtype_, elem_, dir_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.rtype = new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$14.nil, 0, 0);
			this.elem = ptrType$1.nil;
			this.dir = 0;
			return;
		}
		this.rtype = rtype_;
		this.elem = elem_;
		this.dir = dir_;
	});
	imethod = $pkg.imethod = $newType(0, $kindStruct, "reflect.imethod", true, "reflect", false, function(name_, typ_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.name = 0;
			this.typ = 0;
			return;
		}
		this.name = name_;
		this.typ = typ_;
	});
	interfaceType = $pkg.interfaceType = $newType(0, $kindStruct, "reflect.interfaceType", true, "reflect", false, function(rtype_, pkgPath_, methods_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.rtype = new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$14.nil, 0, 0);
			this.pkgPath = new name.ptr(ptrType$14.nil);
			this.methods = sliceType$14.nil;
			return;
		}
		this.rtype = rtype_;
		this.pkgPath = pkgPath_;
		this.methods = methods_;
	});
	mapType = $pkg.mapType = $newType(0, $kindStruct, "reflect.mapType", true, "reflect", false, function(rtype_, key_, elem_, bucket_, hasher_, keysize_, valuesize_, bucketsize_, flags_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.rtype = new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$14.nil, 0, 0);
			this.key = ptrType$1.nil;
			this.elem = ptrType$1.nil;
			this.bucket = ptrType$1.nil;
			this.hasher = $throwNilPointerError;
			this.keysize = 0;
			this.valuesize = 0;
			this.bucketsize = 0;
			this.flags = 0;
			return;
		}
		this.rtype = rtype_;
		this.key = key_;
		this.elem = elem_;
		this.bucket = bucket_;
		this.hasher = hasher_;
		this.keysize = keysize_;
		this.valuesize = valuesize_;
		this.bucketsize = bucketsize_;
		this.flags = flags_;
	});
	ptrType = $pkg.ptrType = $newType(0, $kindStruct, "reflect.ptrType", true, "reflect", false, function(rtype_, elem_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.rtype = new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$14.nil, 0, 0);
			this.elem = ptrType$1.nil;
			return;
		}
		this.rtype = rtype_;
		this.elem = elem_;
	});
	sliceType = $pkg.sliceType = $newType(0, $kindStruct, "reflect.sliceType", true, "reflect", false, function(rtype_, elem_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.rtype = new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$14.nil, 0, 0);
			this.elem = ptrType$1.nil;
			return;
		}
		this.rtype = rtype_;
		this.elem = elem_;
	});
	structField = $pkg.structField = $newType(0, $kindStruct, "reflect.structField", true, "reflect", false, function(name_, typ_, offset_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.name = new name.ptr(ptrType$14.nil);
			this.typ = ptrType$1.nil;
			this.offset = 0;
			return;
		}
		this.name = name_;
		this.typ = typ_;
		this.offset = offset_;
	});
	structType = $pkg.structType = $newType(0, $kindStruct, "reflect.structType", true, "reflect", false, function(rtype_, pkgPath_, fields_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.rtype = new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$14.nil, 0, 0);
			this.pkgPath = new name.ptr(ptrType$14.nil);
			this.fields = sliceType$15.nil;
			return;
		}
		this.rtype = rtype_;
		this.pkgPath = pkgPath_;
		this.fields = fields_;
	});
	Method = $pkg.Method = $newType(0, $kindStruct, "reflect.Method", true, "reflect", true, function(Name_, PkgPath_, Type_, Func_, Index_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.Name = "";
			this.PkgPath = "";
			this.Type = $ifaceNil;
			this.Func = new Value.ptr(ptrType$1.nil, 0, 0);
			this.Index = 0;
			return;
		}
		this.Name = Name_;
		this.PkgPath = PkgPath_;
		this.Type = Type_;
		this.Func = Func_;
		this.Index = Index_;
	});
	nameOff = $pkg.nameOff = $newType(4, $kindInt32, "reflect.nameOff", true, "reflect", false, null);
	typeOff = $pkg.typeOff = $newType(4, $kindInt32, "reflect.typeOff", true, "reflect", false, null);
	textOff = $pkg.textOff = $newType(4, $kindInt32, "reflect.textOff", true, "reflect", false, null);
	StructField = $pkg.StructField = $newType(0, $kindStruct, "reflect.StructField", true, "reflect", true, function(Name_, PkgPath_, Type_, Tag_, Offset_, Index_, Anonymous_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.Name = "";
			this.PkgPath = "";
			this.Type = $ifaceNil;
			this.Tag = "";
			this.Offset = 0;
			this.Index = sliceType$7.nil;
			this.Anonymous = false;
			return;
		}
		this.Name = Name_;
		this.PkgPath = PkgPath_;
		this.Type = Type_;
		this.Tag = Tag_;
		this.Offset = Offset_;
		this.Index = Index_;
		this.Anonymous = Anonymous_;
	});
	StructTag = $pkg.StructTag = $newType(8, $kindString, "reflect.StructTag", true, "reflect", true, null);
	fieldScan = $pkg.fieldScan = $newType(0, $kindStruct, "reflect.fieldScan", true, "reflect", false, function(typ_, index_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.typ = ptrType$13.nil;
			this.index = sliceType$7.nil;
			return;
		}
		this.typ = typ_;
		this.index = index_;
	});
	uncommonType = $pkg.uncommonType = $newType(0, $kindStruct, "reflect.uncommonType", true, "reflect", false, function(pkgPath_, mcount_, xcount_, moff_, _methods_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.pkgPath = 0;
			this.mcount = 0;
			this.xcount = 0;
			this.moff = 0;
			this._methods = sliceType$11.nil;
			return;
		}
		this.pkgPath = pkgPath_;
		this.mcount = mcount_;
		this.xcount = xcount_;
		this.moff = moff_;
		this._methods = _methods_;
	});
	funcType = $pkg.funcType = $newType(0, $kindStruct, "reflect.funcType", true, "reflect", false, function(rtype_, inCount_, outCount_, _in_, _out_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.rtype = new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$14.nil, 0, 0);
			this.inCount = 0;
			this.outCount = 0;
			this._in = sliceType$2.nil;
			this._out = sliceType$2.nil;
			return;
		}
		this.rtype = rtype_;
		this.inCount = inCount_;
		this.outCount = outCount_;
		this._in = _in_;
		this._out = _out_;
	});
	name = $pkg.name = $newType(0, $kindStruct, "reflect.name", true, "reflect", false, function(bytes_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.bytes = ptrType$14.nil;
			return;
		}
		this.bytes = bytes_;
	});
	nameData = $pkg.nameData = $newType(0, $kindStruct, "reflect.nameData", true, "reflect", false, function(name_, tag_, exported_, embedded_, pkgPath_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.name = "";
			this.tag = "";
			this.exported = false;
			this.embedded = false;
			this.pkgPath = "";
			return;
		}
		this.name = name_;
		this.tag = tag_;
		this.exported = exported_;
		this.embedded = embedded_;
		this.pkgPath = pkgPath_;
	});
	hiter = $pkg.hiter = $newType(0, $kindStruct, "reflect.hiter", true, "reflect", false, function(t_, m_, keys_, i_, last_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.t = $ifaceNil;
			this.m = null;
			this.keys = null;
			this.i = 0;
			this.last = null;
			return;
		}
		this.t = t_;
		this.m = m_;
		this.keys = keys_;
		this.i = i_;
		this.last = last_;
	});
	sliceType$1 = $sliceType(name);
	ptrType$1 = $ptrType(rtype);
	sliceType$2 = $sliceType(ptrType$1);
	sliceType$3 = $sliceType($String);
	sliceType$4 = $sliceType($Uint8);
	sliceType$5 = $sliceType($emptyInterface);
	ptrType$2 = $ptrType(js.Object);
	funcType$1 = $funcType([sliceType$5], [ptrType$2], true);
	sliceType$7 = $sliceType($Int);
	sliceType$8 = $sliceType(Value);
	ptrType$6 = $ptrType(runtime.Func);
	ptrType$8 = $ptrType($UnsafePointer);
	ptrType$9 = $ptrType(unsafeheader.Slice);
	sliceType$10 = $sliceType($Int32);
	ptrType$10 = $ptrType(uncommonType);
	sliceType$11 = $sliceType(method);
	ptrType$11 = $ptrType(interfaceType);
	ptrType$12 = $ptrType(imethod);
	sliceType$12 = $sliceType(fieldScan);
	ptrType$13 = $ptrType(structType);
	ptrType$14 = $ptrType($Uint8);
	funcType$2 = $funcType([], [], false);
	sliceType$14 = $sliceType(imethod);
	sliceType$15 = $sliceType(structField);
	ptrType$18 = $ptrType(nameData);
	structType$3 = $structType("reflect", [{prop: "str", name: "str", embedded: false, exported: false, typ: $String, tag: ""}]);
	sliceType$16 = $sliceType(ptrType$2);
	ptrType$19 = $ptrType($String);
	ptrType$20 = $ptrType(funcType);
	sliceType$17 = $sliceType(Type);
	sliceType$18 = $sliceType(sliceType$16);
	arrayType$7 = $arrayType($Uintptr, 5);
	sliceType$20 = $sliceType($Uintptr);
	funcType$3 = $funcType([$String], [$Bool], false);
	ptrType$23 = $ptrType(MapIter);
	arrayType$8 = $arrayType($Uintptr, 2);
	ptrType$24 = $ptrType(ValueError);
	funcType$4 = $funcType([$UnsafePointer, $UnsafePointer], [$Bool], false);
	funcType$5 = $funcType([$UnsafePointer, $Uintptr], [$Uintptr], false);
	ptrType$26 = $ptrType(structField);
	ptrType$27 = $ptrType(hiter);
	flag.prototype.kind = function() {
		var f;
		f = this.$val;
		return ((((f & 31) >>> 0) >>> 0));
	};
	$ptrType(flag).prototype.kind = function() { return new flag(this.$get()).kind(); };
	flag.prototype.ro = function() {
		var f;
		f = this.$val;
		if (!((((f & 96) >>> 0) === 0))) {
			return 32;
		}
		return 0;
	};
	$ptrType(flag).prototype.ro = function() { return new flag(this.$get()).ro(); };
	Value.ptr.prototype.pointer = function() {
		var v;
		v = this;
		if (!((v.typ.size === 4)) || !v.typ.pointers()) {
			$panic(new $String("can't call pointer on a non-pointer Value"));
		}
		if (!((((v.flag & 128) >>> 0) === 0))) {
			return (v.ptr).$get();
		}
		return v.ptr;
	};
	Value.prototype.pointer = function() { return this.$val.pointer(); };
	ValueError.ptr.prototype.Error = function() {
		var e;
		e = this;
		if (e.Kind === 0) {
			return "reflect: call of " + e.Method + " on zero Value";
		}
		return "reflect: call of " + e.Method + " on " + new Kind(e.Kind).String() + " Value";
	};
	ValueError.prototype.Error = function() { return this.$val.Error(); };
	flag.prototype.mustBe = function(expected) {
		var expected, f;
		f = this.$val;
		if (!((((((f & 31) >>> 0) >>> 0)) === expected))) {
			$panic(new ValueError.ptr(valueMethodName(), new flag(f).kind()));
		}
	};
	$ptrType(flag).prototype.mustBe = function(expected) { return new flag(this.$get()).mustBe(expected); };
	flag.prototype.mustBeExported = function() {
		var f;
		f = this.$val;
		if ((f === 0) || !((((f & 96) >>> 0) === 0))) {
			new flag(f).mustBeExportedSlow();
		}
	};
	$ptrType(flag).prototype.mustBeExported = function() { return new flag(this.$get()).mustBeExported(); };
	flag.prototype.mustBeExportedSlow = function() {
		var f;
		f = this.$val;
		if (f === 0) {
			$panic(new ValueError.ptr(valueMethodName(), 0));
		}
		if (!((((f & 96) >>> 0) === 0))) {
			$panic(new $String("reflect: " + valueMethodName() + " using value obtained using unexported field"));
		}
	};
	$ptrType(flag).prototype.mustBeExportedSlow = function() { return new flag(this.$get()).mustBeExportedSlow(); };
	flag.prototype.mustBeAssignable = function() {
		var f;
		f = this.$val;
		if (!((((f & 96) >>> 0) === 0)) || (((f & 256) >>> 0) === 0)) {
			new flag(f).mustBeAssignableSlow();
		}
	};
	$ptrType(flag).prototype.mustBeAssignable = function() { return new flag(this.$get()).mustBeAssignable(); };
	flag.prototype.mustBeAssignableSlow = function() {
		var f;
		f = this.$val;
		if (f === 0) {
			$panic(new ValueError.ptr(valueMethodName(), 0));
		}
		if (!((((f & 96) >>> 0) === 0))) {
			$panic(new $String("reflect: " + valueMethodName() + " using value obtained using unexported field"));
		}
		if (((f & 256) >>> 0) === 0) {
			$panic(new $String("reflect: " + valueMethodName() + " using unaddressable value"));
		}
	};
	$ptrType(flag).prototype.mustBeAssignableSlow = function() { return new flag(this.$get()).mustBeAssignableSlow(); };
	Value.ptr.prototype.Addr = function() {
		var fl, v;
		v = this;
		if (((v.flag & 256) >>> 0) === 0) {
			$panic(new $String("reflect.Value.Addr of unaddressable value"));
		}
		fl = (v.flag & 96) >>> 0;
		return new Value.ptr(v.typ.ptrTo(), v.ptr, (fl | 22) >>> 0);
	};
	Value.prototype.Addr = function() { return this.$val.Addr(); };
	Value.ptr.prototype.Bool = function() {
		var v;
		v = this;
		if (!((new flag(v.flag).kind() === 1))) {
			$clone(v, Value).panicNotBool();
		}
		return (v.ptr).$get();
	};
	Value.prototype.Bool = function() { return this.$val.Bool(); };
	Value.ptr.prototype.panicNotBool = function() {
		var v;
		v = this;
		new flag(v.flag).mustBe(1);
	};
	Value.prototype.panicNotBool = function() { return this.$val.panicNotBool(); };
	Value.ptr.prototype.Bytes = function() {
		var {$24r, _r, v, $s, $r, $c} = $restore(this, {});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		v = this;
		if (v.typ === bytesType) {
			$s = -1; return (v.ptr).$get();
		}
		_r = $clone(v, Value).bytesSlow(); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		$24r = _r;
		$s = 2; case 2: return $24r;
		/* */ } return; } var $f = {$blk: Value.ptr.prototype.Bytes, $c: true, $r, $24r, _r, v, $s};return $f;
	};
	Value.prototype.Bytes = function() { return this.$val.Bytes(); };
	Value.ptr.prototype.runes = function() {
		var {_r, v, $s, $r, $c} = $restore(this, {});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		v = this;
		new flag(v.flag).mustBe(23);
		_r = v.typ.Elem().Kind(); /* */ $s = 3; case 3: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		/* */ if (!((_r === 5))) { $s = 1; continue; }
		/* */ $s = 2; continue;
		/* if (!((_r === 5))) { */ case 1:
			$panic(new $String("reflect.Value.Bytes of non-rune slice"));
		/* } */ case 2:
		$s = -1; return (v.ptr).$get();
		/* */ } return; } var $f = {$blk: Value.ptr.prototype.runes, $c: true, $r, _r, v, $s};return $f;
	};
	Value.prototype.runes = function() { return this.$val.runes(); };
	Value.ptr.prototype.CanAddr = function() {
		var v;
		v = this;
		return !((((v.flag & 256) >>> 0) === 0));
	};
	Value.prototype.CanAddr = function() { return this.$val.CanAddr(); };
	Value.ptr.prototype.CanSet = function() {
		var v;
		v = this;
		return ((v.flag & 352) >>> 0) === 256;
	};
	Value.prototype.CanSet = function() { return this.$val.CanSet(); };
	Value.ptr.prototype.Call = function(in$1) {
		var {$24r, _r, in$1, v, $s, $r, $c} = $restore(this, {in$1});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		v = this;
		new flag(v.flag).mustBe(19);
		new flag(v.flag).mustBeExported();
		_r = $clone(v, Value).call("Call", in$1); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		$24r = _r;
		$s = 2; case 2: return $24r;
		/* */ } return; } var $f = {$blk: Value.ptr.prototype.Call, $c: true, $r, $24r, _r, in$1, v, $s};return $f;
	};
	Value.prototype.Call = function(in$1) { return this.$val.Call(in$1); };
	Value.ptr.prototype.CallSlice = function(in$1) {
		var {$24r, _r, in$1, v, $s, $r, $c} = $restore(this, {in$1});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		v = this;
		new flag(v.flag).mustBe(19);
		new flag(v.flag).mustBeExported();
		_r = $clone(v, Value).call("CallSlice", in$1); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		$24r = _r;
		$s = 2; case 2: return $24r;
		/* */ } return; } var $f = {$blk: Value.ptr.prototype.CallSlice, $c: true, $r, $24r, _r, in$1, v, $s};return $f;
	};
	Value.prototype.CallSlice = function(in$1) { return this.$val.CallSlice(in$1); };
	Value.ptr.prototype.CanComplex = function() {
		var _1, v;
		v = this;
		_1 = new flag(v.flag).kind();
		if ((_1 === (15)) || (_1 === (16))) {
			return true;
		} else {
			return false;
		}
	};
	Value.prototype.CanComplex = function() { return this.$val.CanComplex(); };
	Value.ptr.prototype.Complex = function() {
		var _1, k, v, x;
		v = this;
		k = new flag(v.flag).kind();
		_1 = k;
		if (_1 === (15)) {
			return ((x = (v.ptr).$get(), new $Complex128(x.$real, x.$imag)));
		} else if (_1 === (16)) {
			return (v.ptr).$get();
		}
		$panic(new ValueError.ptr("reflect.Value.Complex", new flag(v.flag).kind()));
	};
	Value.prototype.Complex = function() { return this.$val.Complex(); };
	Value.ptr.prototype.FieldByIndex = function(index) {
		var {$24r, _i, _r, _r$1, _r$2, _r$3, _ref, _v, i, index, v, x, $s, $r, $c} = $restore(this, {index});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		v = this;
		/* */ if (index.$length === 1) { $s = 1; continue; }
		/* */ $s = 2; continue;
		/* if (index.$length === 1) { */ case 1:
			_r = $clone(v, Value).Field((0 >= index.$length ? ($throwRuntimeError("index out of range"), undefined) : index.$array[index.$offset + 0])); /* */ $s = 3; case 3: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
			$24r = _r;
			$s = 4; case 4: return $24r;
		/* } */ case 2:
		new flag(v.flag).mustBe(25);
		_ref = index;
		_i = 0;
		/* while (true) { */ case 5:
			/* if (!(_i < _ref.$length)) { break; } */ if(!(_i < _ref.$length)) { $s = 6; continue; }
			i = _i;
			x = ((_i < 0 || _i >= _ref.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref.$array[_ref.$offset + _i]);
			/* */ if (i > 0) { $s = 7; continue; }
			/* */ $s = 8; continue;
			/* if (i > 0) { */ case 7:
				if (!($clone(v, Value).Kind() === 22)) { _v = false; $s = 11; continue s; }
				_r$1 = v.typ.Elem().Kind(); /* */ $s = 12; case 12: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
				_v = _r$1 === 25; case 11:
				/* */ if (_v) { $s = 9; continue; }
				/* */ $s = 10; continue;
				/* if (_v) { */ case 9:
					if ($clone(v, Value).IsNil()) {
						$panic(new $String("reflect: indirection through nil pointer to embedded struct"));
					}
					_r$2 = $clone(v, Value).Elem(); /* */ $s = 13; case 13: if($c) { $c = false; _r$2 = _r$2.$blk(); } if (_r$2 && _r$2.$blk !== undefined) { break s; }
					v = _r$2;
				/* } */ case 10:
			/* } */ case 8:
			_r$3 = $clone(v, Value).Field(x); /* */ $s = 14; case 14: if($c) { $c = false; _r$3 = _r$3.$blk(); } if (_r$3 && _r$3.$blk !== undefined) { break s; }
			v = _r$3;
			_i++;
		$s = 5; continue;
		case 6:
		$s = -1; return v;
		/* */ } return; } var $f = {$blk: Value.ptr.prototype.FieldByIndex, $c: true, $r, $24r, _i, _r, _r$1, _r$2, _r$3, _ref, _v, i, index, v, x, $s};return $f;
	};
	Value.prototype.FieldByIndex = function(index) { return this.$val.FieldByIndex(index); };
	Value.ptr.prototype.FieldByIndexErr = function(index) {
		var {$24r, $24r$1, _i, _r, _r$1, _r$2, _r$3, _r$4, _r$5, _ref, _v, i, index, v, x, $s, $r, $c} = $restore(this, {index});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		v = this;
		/* */ if (index.$length === 1) { $s = 1; continue; }
		/* */ $s = 2; continue;
		/* if (index.$length === 1) { */ case 1:
			_r = $clone(v, Value).Field((0 >= index.$length ? ($throwRuntimeError("index out of range"), undefined) : index.$array[index.$offset + 0])); /* */ $s = 3; case 3: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
			$24r = [_r, $ifaceNil];
			$s = 4; case 4: return $24r;
		/* } */ case 2:
		new flag(v.flag).mustBe(25);
		_ref = index;
		_i = 0;
		/* while (true) { */ case 5:
			/* if (!(_i < _ref.$length)) { break; } */ if(!(_i < _ref.$length)) { $s = 6; continue; }
			i = _i;
			x = ((_i < 0 || _i >= _ref.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref.$array[_ref.$offset + _i]);
			/* */ if (i > 0) { $s = 7; continue; }
			/* */ $s = 8; continue;
			/* if (i > 0) { */ case 7:
				if (!($clone(v, Value).Kind() === 22)) { _v = false; $s = 11; continue s; }
				_r$1 = v.typ.Elem().Kind(); /* */ $s = 12; case 12: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
				_v = _r$1 === 25; case 11:
				/* */ if (_v) { $s = 9; continue; }
				/* */ $s = 10; continue;
				/* if (_v) { */ case 9:
					/* */ if ($clone(v, Value).IsNil()) { $s = 13; continue; }
					/* */ $s = 14; continue;
					/* if ($clone(v, Value).IsNil()) { */ case 13:
						_r$2 = v.typ.Elem().Name(); /* */ $s = 15; case 15: if($c) { $c = false; _r$2 = _r$2.$blk(); } if (_r$2 && _r$2.$blk !== undefined) { break s; }
						_r$3 = errors.New("reflect: indirection through nil pointer to embedded struct field " + _r$2); /* */ $s = 16; case 16: if($c) { $c = false; _r$3 = _r$3.$blk(); } if (_r$3 && _r$3.$blk !== undefined) { break s; }
						$24r$1 = [new Value.ptr(ptrType$1.nil, 0, 0), _r$3];
						$s = 17; case 17: return $24r$1;
					/* } */ case 14:
					_r$4 = $clone(v, Value).Elem(); /* */ $s = 18; case 18: if($c) { $c = false; _r$4 = _r$4.$blk(); } if (_r$4 && _r$4.$blk !== undefined) { break s; }
					v = _r$4;
				/* } */ case 10:
			/* } */ case 8:
			_r$5 = $clone(v, Value).Field(x); /* */ $s = 19; case 19: if($c) { $c = false; _r$5 = _r$5.$blk(); } if (_r$5 && _r$5.$blk !== undefined) { break s; }
			v = _r$5;
			_i++;
		$s = 5; continue;
		case 6:
		$s = -1; return [v, $ifaceNil];
		/* */ } return; } var $f = {$blk: Value.ptr.prototype.FieldByIndexErr, $c: true, $r, $24r, $24r$1, _i, _r, _r$1, _r$2, _r$3, _r$4, _r$5, _ref, _v, i, index, v, x, $s};return $f;
	};
	Value.prototype.FieldByIndexErr = function(index) { return this.$val.FieldByIndexErr(index); };
	Value.ptr.prototype.FieldByName = function(name$1) {
		var {$24r, _r, _r$1, _tuple, f, name$1, ok, v, $s, $r, $c} = $restore(this, {name$1});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		v = this;
		new flag(v.flag).mustBe(25);
		_r = v.typ.FieldByName(name$1); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		_tuple = _r;
		f = $clone(_tuple[0], StructField);
		ok = _tuple[1];
		/* */ if (ok) { $s = 2; continue; }
		/* */ $s = 3; continue;
		/* if (ok) { */ case 2:
			_r$1 = $clone(v, Value).FieldByIndex(f.Index); /* */ $s = 4; case 4: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
			$24r = _r$1;
			$s = 5; case 5: return $24r;
		/* } */ case 3:
		$s = -1; return new Value.ptr(ptrType$1.nil, 0, 0);
		/* */ } return; } var $f = {$blk: Value.ptr.prototype.FieldByName, $c: true, $r, $24r, _r, _r$1, _tuple, f, name$1, ok, v, $s};return $f;
	};
	Value.prototype.FieldByName = function(name$1) { return this.$val.FieldByName(name$1); };
	Value.ptr.prototype.FieldByNameFunc = function(match) {
		var {$24r, _r, _r$1, _tuple, f, match, ok, v, $s, $r, $c} = $restore(this, {match});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		v = this;
		_r = v.typ.FieldByNameFunc(match); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		_tuple = _r;
		f = $clone(_tuple[0], StructField);
		ok = _tuple[1];
		/* */ if (ok) { $s = 2; continue; }
		/* */ $s = 3; continue;
		/* if (ok) { */ case 2:
			_r$1 = $clone(v, Value).FieldByIndex(f.Index); /* */ $s = 4; case 4: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
			$24r = _r$1;
			$s = 5; case 5: return $24r;
		/* } */ case 3:
		$s = -1; return new Value.ptr(ptrType$1.nil, 0, 0);
		/* */ } return; } var $f = {$blk: Value.ptr.prototype.FieldByNameFunc, $c: true, $r, $24r, _r, _r$1, _tuple, f, match, ok, v, $s};return $f;
	};
	Value.prototype.FieldByNameFunc = function(match) { return this.$val.FieldByNameFunc(match); };
	Value.ptr.prototype.CanFloat = function() {
		var _1, v;
		v = this;
		_1 = new flag(v.flag).kind();
		if ((_1 === (13)) || (_1 === (14))) {
			return true;
		} else {
			return false;
		}
	};
	Value.prototype.CanFloat = function() { return this.$val.CanFloat(); };
	Value.ptr.prototype.Float = function() {
		var _1, k, v;
		v = this;
		k = new flag(v.flag).kind();
		_1 = k;
		if (_1 === (13)) {
			return ((v.ptr).$get());
		} else if (_1 === (14)) {
			return (v.ptr).$get();
		}
		$panic(new ValueError.ptr("reflect.Value.Float", new flag(v.flag).kind()));
	};
	Value.prototype.Float = function() { return this.$val.Float(); };
	Value.ptr.prototype.CanInt = function() {
		var _1, v;
		v = this;
		_1 = new flag(v.flag).kind();
		if ((_1 === (2)) || (_1 === (3)) || (_1 === (4)) || (_1 === (5)) || (_1 === (6))) {
			return true;
		} else {
			return false;
		}
	};
	Value.prototype.CanInt = function() { return this.$val.CanInt(); };
	Value.ptr.prototype.Int = function() {
		var _1, k, p, v;
		v = this;
		k = new flag(v.flag).kind();
		p = v.ptr;
		_1 = k;
		if (_1 === (2)) {
			return (new $Int64(0, (p).$get()));
		} else if (_1 === (3)) {
			return (new $Int64(0, (p).$get()));
		} else if (_1 === (4)) {
			return (new $Int64(0, (p).$get()));
		} else if (_1 === (5)) {
			return (new $Int64(0, (p).$get()));
		} else if (_1 === (6)) {
			return (p).$get();
		}
		$panic(new ValueError.ptr("reflect.Value.Int", new flag(v.flag).kind()));
	};
	Value.prototype.Int = function() { return this.$val.Int(); };
	Value.ptr.prototype.CanInterface = function() {
		var v;
		v = this;
		if (v.flag === 0) {
			$panic(new ValueError.ptr("reflect.Value.CanInterface", 0));
		}
		return ((v.flag & 96) >>> 0) === 0;
	};
	Value.prototype.CanInterface = function() { return this.$val.CanInterface(); };
	Value.ptr.prototype.Interface = function() {
		var {$24r, _r, i, v, $s, $r, $c} = $restore(this, {});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		i = $ifaceNil;
		v = this;
		_r = valueInterface($clone(v, Value), true); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		i = _r;
		$24r = i;
		$s = 2; case 2: return $24r;
		/* */ } return; } var $f = {$blk: Value.ptr.prototype.Interface, $c: true, $r, $24r, _r, i, v, $s};return $f;
	};
	Value.prototype.Interface = function() { return this.$val.Interface(); };
	Value.ptr.prototype.IsValid = function() {
		var v;
		v = this;
		return !((v.flag === 0));
	};
	Value.prototype.IsValid = function() { return this.$val.IsValid(); };
	Value.ptr.prototype.IsZero = function() {
		var {$24r, _1, _r, _r$1, _r$2, _r$3, _r$4, _r$5, c, i, i$1, v, x, x$1, x$2, x$3, x$4, $s, $r, $c} = $restore(this, {});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		v = this;
			_1 = new flag(v.flag).kind();
			/* */ if (_1 === (1)) { $s = 2; continue; }
			/* */ if ((_1 === (2)) || (_1 === (3)) || (_1 === (4)) || (_1 === (5)) || (_1 === (6))) { $s = 3; continue; }
			/* */ if ((_1 === (7)) || (_1 === (8)) || (_1 === (9)) || (_1 === (10)) || (_1 === (11)) || (_1 === (12))) { $s = 4; continue; }
			/* */ if ((_1 === (13)) || (_1 === (14))) { $s = 5; continue; }
			/* */ if ((_1 === (15)) || (_1 === (16))) { $s = 6; continue; }
			/* */ if (_1 === (17)) { $s = 7; continue; }
			/* */ if ((_1 === (18)) || (_1 === (19)) || (_1 === (20)) || (_1 === (21)) || (_1 === (22)) || (_1 === (23)) || (_1 === (26))) { $s = 8; continue; }
			/* */ if (_1 === (24)) { $s = 9; continue; }
			/* */ if (_1 === (25)) { $s = 10; continue; }
			/* */ $s = 11; continue;
			/* if (_1 === (1)) { */ case 2:
				$s = -1; return !$clone(v, Value).Bool();
			/* } else if ((_1 === (2)) || (_1 === (3)) || (_1 === (4)) || (_1 === (5)) || (_1 === (6))) { */ case 3:
				$s = -1; return (x = $clone(v, Value).Int(), (x.$high === 0 && x.$low === 0));
			/* } else if ((_1 === (7)) || (_1 === (8)) || (_1 === (9)) || (_1 === (10)) || (_1 === (11)) || (_1 === (12))) { */ case 4:
				$s = -1; return (x$1 = $clone(v, Value).Uint(), (x$1.$high === 0 && x$1.$low === 0));
			/* } else if ((_1 === (13)) || (_1 === (14))) { */ case 5:
				$s = -1; return (x$2 = math.Float64bits($clone(v, Value).Float()), (x$2.$high === 0 && x$2.$low === 0));
			/* } else if ((_1 === (15)) || (_1 === (16))) { */ case 6:
				c = $clone(v, Value).Complex();
				$s = -1; return (x$3 = math.Float64bits(c.$real), (x$3.$high === 0 && x$3.$low === 0)) && (x$4 = math.Float64bits(c.$imag), (x$4.$high === 0 && x$4.$low === 0));
			/* } else if (_1 === (17)) { */ case 7:
				i = 0;
				/* while (true) { */ case 13:
					_r = $clone(v, Value).Len(); /* */ $s = 15; case 15: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
					/* if (!(i < _r)) { break; } */ if(!(i < _r)) { $s = 14; continue; }
					_r$1 = $clone(v, Value).Index(i); /* */ $s = 18; case 18: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
					_r$2 = $clone(_r$1, Value).IsZero(); /* */ $s = 19; case 19: if($c) { $c = false; _r$2 = _r$2.$blk(); } if (_r$2 && _r$2.$blk !== undefined) { break s; }
					/* */ if (!_r$2) { $s = 16; continue; }
					/* */ $s = 17; continue;
					/* if (!_r$2) { */ case 16:
						$s = -1; return false;
					/* } */ case 17:
					i = i + (1) >> 0;
				$s = 13; continue;
				case 14:
				$s = -1; return true;
			/* } else if ((_1 === (18)) || (_1 === (19)) || (_1 === (20)) || (_1 === (21)) || (_1 === (22)) || (_1 === (23)) || (_1 === (26))) { */ case 8:
				$s = -1; return $clone(v, Value).IsNil();
			/* } else if (_1 === (24)) { */ case 9:
				_r$3 = $clone(v, Value).Len(); /* */ $s = 20; case 20: if($c) { $c = false; _r$3 = _r$3.$blk(); } if (_r$3 && _r$3.$blk !== undefined) { break s; }
				$24r = _r$3 === 0;
				$s = 21; case 21: return $24r;
			/* } else if (_1 === (25)) { */ case 10:
				i$1 = 0;
				/* while (true) { */ case 22:
					/* if (!(i$1 < $clone(v, Value).NumField())) { break; } */ if(!(i$1 < $clone(v, Value).NumField())) { $s = 23; continue; }
					_r$4 = $clone(v, Value).Field(i$1); /* */ $s = 26; case 26: if($c) { $c = false; _r$4 = _r$4.$blk(); } if (_r$4 && _r$4.$blk !== undefined) { break s; }
					_r$5 = $clone(_r$4, Value).IsZero(); /* */ $s = 27; case 27: if($c) { $c = false; _r$5 = _r$5.$blk(); } if (_r$5 && _r$5.$blk !== undefined) { break s; }
					/* */ if (!_r$5) { $s = 24; continue; }
					/* */ $s = 25; continue;
					/* if (!_r$5) { */ case 24:
						$s = -1; return false;
					/* } */ case 25:
					i$1 = i$1 + (1) >> 0;
				$s = 22; continue;
				case 23:
				$s = -1; return true;
			/* } else { */ case 11:
				$panic(new ValueError.ptr("reflect.Value.IsZero", $clone(v, Value).Kind()));
			/* } */ case 12:
		case 1:
		$s = -1; return false;
		/* */ } return; } var $f = {$blk: Value.ptr.prototype.IsZero, $c: true, $r, $24r, _1, _r, _r$1, _r$2, _r$3, _r$4, _r$5, c, i, i$1, v, x, x$1, x$2, x$3, x$4, $s};return $f;
	};
	Value.prototype.IsZero = function() { return this.$val.IsZero(); };
	Value.ptr.prototype.Kind = function() {
		var v;
		v = this;
		return new flag(v.flag).kind();
	};
	Value.prototype.Kind = function() { return this.$val.Kind(); };
	Value.ptr.prototype.MapIndex = function(key) {
		var {_r, e, fl, k, k$1, key, tt, typ, v, $s, $r, $c} = $restore(this, {key});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		v = this;
		new flag(v.flag).mustBe(21);
		tt = (v.typ.kindType);
		e = 0;
		/* */ if ((tt.key === stringType || (new flag(key.flag).kind() === 24)) && tt.key === key.typ && tt.elem.size <= 128) { $s = 1; continue; }
		/* */ $s = 2; continue;
		/* if ((tt.key === stringType || (new flag(key.flag).kind() === 24)) && tt.key === key.typ && tt.elem.size <= 128) { */ case 1:
			k = (key.ptr).$get();
			e = mapaccess_faststr(v.typ, $clone(v, Value).pointer(), k);
			$s = 3; continue;
		/* } else { */ case 2:
			_r = $clone(key, Value).assignTo("reflect.Value.MapIndex", tt.key, 0); /* */ $s = 4; case 4: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
			key = _r;
			k$1 = 0;
			if (!((((key.flag & 128) >>> 0) === 0))) {
				k$1 = key.ptr;
			} else {
				k$1 = ((key.$ptr_ptr || (key.$ptr_ptr = new ptrType$8(function() { return this.$target.ptr; }, function($v) { this.$target.ptr = $v; }, key))));
			}
			e = mapaccess(v.typ, $clone(v, Value).pointer(), k$1);
		/* } */ case 3:
		if (e === 0) {
			$s = -1; return new Value.ptr(ptrType$1.nil, 0, 0);
		}
		typ = tt.elem;
		fl = new flag((((v.flag | key.flag) >>> 0))).ro();
		fl = (fl | (((typ.Kind() >>> 0)))) >>> 0;
		$s = -1; return copyVal(typ, fl, e);
		/* */ } return; } var $f = {$blk: Value.ptr.prototype.MapIndex, $c: true, $r, _r, e, fl, k, k$1, key, tt, typ, v, $s};return $f;
	};
	Value.prototype.MapIndex = function(key) { return this.$val.MapIndex(key); };
	Value.ptr.prototype.MapKeys = function() {
		var {_r, a, fl, i, it, key, keyType, m, mlen, tt, v, $s, $r, $c} = $restore(this, {});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		it = [it];
		v = this;
		new flag(v.flag).mustBe(21);
		tt = (v.typ.kindType);
		keyType = tt.key;
		fl = (new flag(v.flag).ro() | ((keyType.Kind() >>> 0))) >>> 0;
		m = $clone(v, Value).pointer();
		mlen = 0;
		if (!(m === 0)) {
			mlen = maplen(m);
		}
		it[0] = new hiter.ptr($ifaceNil, null, null, 0, null);
		mapiterinit(v.typ, m, it[0]);
		a = $makeSlice(sliceType$8, mlen);
		i = 0;
		i = 0;
		/* while (true) { */ case 1:
			/* if (!(i < a.$length)) { break; } */ if(!(i < a.$length)) { $s = 2; continue; }
			_r = mapiterkey(it[0]); /* */ $s = 3; case 3: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
			key = _r;
			if (key === 0) {
				/* break; */ $s = 2; continue;
			}
			((i < 0 || i >= a.$length) ? ($throwRuntimeError("index out of range"), undefined) : a.$array[a.$offset + i] = copyVal(keyType, fl, key));
			mapiternext(it[0]);
			i = i + (1) >> 0;
		$s = 1; continue;
		case 2:
		$s = -1; return $subslice(a, 0, i);
		/* */ } return; } var $f = {$blk: Value.ptr.prototype.MapKeys, $c: true, $r, _r, a, fl, i, it, key, keyType, m, mlen, tt, v, $s};return $f;
	};
	Value.prototype.MapKeys = function() { return this.$val.MapKeys(); };
	hiter.ptr.prototype.initialized = function() {
		var h;
		h = this;
		return !($interfaceIsEqual(h.t, $ifaceNil));
	};
	hiter.prototype.initialized = function() { return this.$val.initialized(); };
	MapIter.ptr.prototype.Key = function() {
		var {_r, iter, iterkey, ktype, t, $s, $r, $c} = $restore(this, {});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		iter = this;
		if (!iter.hiter.initialized()) {
			$panic(new $String("MapIter.Key called before Next"));
		}
		_r = mapiterkey(iter.hiter); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		iterkey = _r;
		if (iterkey === 0) {
			$panic(new $String("MapIter.Key called on exhausted iterator"));
		}
		t = (iter.m.typ.kindType);
		ktype = t.key;
		$s = -1; return copyVal(ktype, (new flag(iter.m.flag).ro() | ((ktype.Kind() >>> 0))) >>> 0, iterkey);
		/* */ } return; } var $f = {$blk: MapIter.ptr.prototype.Key, $c: true, $r, _r, iter, iterkey, ktype, t, $s};return $f;
	};
	MapIter.prototype.Key = function() { return this.$val.Key(); };
	Value.ptr.prototype.SetIterKey = function(iter) {
		var {_r, _r$1, iter, iterkey, key, ktype, t, target, v, $s, $r, $c} = $restore(this, {iter});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		v = this;
		if (!iter.hiter.initialized()) {
			$panic(new $String("reflect: Value.SetIterKey called before Next"));
		}
		_r = mapiterkey(iter.hiter); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		iterkey = _r;
		if (iterkey === 0) {
			$panic(new $String("reflect: Value.SetIterKey called on exhausted iterator"));
		}
		new flag(v.flag).mustBeAssignable();
		target = 0;
		if (new flag(v.flag).kind() === 20) {
			target = v.ptr;
		}
		t = (iter.m.typ.kindType);
		ktype = t.key;
		key = new Value.ptr(ktype, iterkey, (((iter.m.flag | ((ktype.Kind() >>> 0))) >>> 0) | 128) >>> 0);
		_r$1 = $clone(key, Value).assignTo("reflect.MapIter.SetKey", v.typ, target); /* */ $s = 2; case 2: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
		key = _r$1;
		typedmemmove(v.typ, v.ptr, key.ptr);
		$s = -1; return;
		/* */ } return; } var $f = {$blk: Value.ptr.prototype.SetIterKey, $c: true, $r, _r, _r$1, iter, iterkey, key, ktype, t, target, v, $s};return $f;
	};
	Value.prototype.SetIterKey = function(iter) { return this.$val.SetIterKey(iter); };
	MapIter.ptr.prototype.Value = function() {
		var {_r, iter, iterelem, t, vtype, $s, $r, $c} = $restore(this, {});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		iter = this;
		if (!iter.hiter.initialized()) {
			$panic(new $String("MapIter.Value called before Next"));
		}
		_r = mapiterelem(iter.hiter); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		iterelem = _r;
		if (iterelem === 0) {
			$panic(new $String("MapIter.Value called on exhausted iterator"));
		}
		t = (iter.m.typ.kindType);
		vtype = t.elem;
		$s = -1; return copyVal(vtype, (new flag(iter.m.flag).ro() | ((vtype.Kind() >>> 0))) >>> 0, iterelem);
		/* */ } return; } var $f = {$blk: MapIter.ptr.prototype.Value, $c: true, $r, _r, iter, iterelem, t, vtype, $s};return $f;
	};
	MapIter.prototype.Value = function() { return this.$val.Value(); };
	Value.ptr.prototype.SetIterValue = function(iter) {
		var {_r, _r$1, elem, iter, iterelem, t, target, v, vtype, $s, $r, $c} = $restore(this, {iter});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		v = this;
		if (!iter.hiter.initialized()) {
			$panic(new $String("reflect: Value.SetIterValue called before Next"));
		}
		_r = mapiterelem(iter.hiter); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		iterelem = _r;
		if (iterelem === 0) {
			$panic(new $String("reflect: Value.SetIterValue called on exhausted iterator"));
		}
		new flag(v.flag).mustBeAssignable();
		target = 0;
		if (new flag(v.flag).kind() === 20) {
			target = v.ptr;
		}
		t = (iter.m.typ.kindType);
		vtype = t.elem;
		elem = new Value.ptr(vtype, iterelem, (((iter.m.flag | ((vtype.Kind() >>> 0))) >>> 0) | 128) >>> 0);
		_r$1 = $clone(elem, Value).assignTo("reflect.MapIter.SetValue", v.typ, target); /* */ $s = 2; case 2: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
		elem = _r$1;
		typedmemmove(v.typ, v.ptr, elem.ptr);
		$s = -1; return;
		/* */ } return; } var $f = {$blk: Value.ptr.prototype.SetIterValue, $c: true, $r, _r, _r$1, elem, iter, iterelem, t, target, v, vtype, $s};return $f;
	};
	Value.prototype.SetIterValue = function(iter) { return this.$val.SetIterValue(iter); };
	MapIter.ptr.prototype.Next = function() {
		var {$24r, _r, _r$1, iter, $s, $r, $c} = $restore(this, {});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		iter = this;
		if (!$clone(iter.m, Value).IsValid()) {
			$panic(new $String("MapIter.Next called on an iterator that does not have an associated map Value"));
		}
		/* */ if (!iter.hiter.initialized()) { $s = 1; continue; }
		/* */ $s = 2; continue;
		/* if (!iter.hiter.initialized()) { */ case 1:
			mapiterinit(iter.m.typ, $clone(iter.m, Value).pointer(), iter.hiter);
			$s = 3; continue;
		/* } else { */ case 2:
			_r = mapiterkey(iter.hiter); /* */ $s = 6; case 6: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
			/* */ if (_r === 0) { $s = 4; continue; }
			/* */ $s = 5; continue;
			/* if (_r === 0) { */ case 4:
				$panic(new $String("MapIter.Next called on exhausted iterator"));
			/* } */ case 5:
			mapiternext(iter.hiter);
		/* } */ case 3:
		_r$1 = mapiterkey(iter.hiter); /* */ $s = 7; case 7: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
		$24r = !(_r$1 === 0);
		$s = 8; case 8: return $24r;
		/* */ } return; } var $f = {$blk: MapIter.ptr.prototype.Next, $c: true, $r, $24r, _r, _r$1, iter, $s};return $f;
	};
	MapIter.prototype.Next = function() { return this.$val.Next(); };
	MapIter.ptr.prototype.Reset = function(v) {
		var iter, v;
		iter = this;
		if ($clone(v, Value).IsValid()) {
			new flag(v.flag).mustBe(21);
		}
		iter.m = v;
		hiter.copy(iter.hiter, new hiter.ptr($ifaceNil, null, null, 0, null));
	};
	MapIter.prototype.Reset = function(v) { return this.$val.Reset(v); };
	Value.ptr.prototype.MapRange = function() {
		var v;
		v = this;
		if (!((new flag(v.flag).kind() === 21))) {
			new flag(v.flag).panicNotMap();
		}
		return new MapIter.ptr($clone(v, Value), new hiter.ptr($ifaceNil, null, null, 0, null));
	};
	Value.prototype.MapRange = function() { return this.$val.MapRange(); };
	flag.prototype.panicNotMap = function() {
		var f;
		f = this.$val;
		new flag(f).mustBe(21);
	};
	$ptrType(flag).prototype.panicNotMap = function() { return new flag(this.$get()).panicNotMap(); };
	copyVal = function(typ, fl, ptr) {
		var c, fl, ptr, typ;
		if (ifaceIndir(typ)) {
			c = unsafe_New(typ);
			typedmemmove(typ, c, ptr);
			return new Value.ptr(typ, c, (fl | 128) >>> 0);
		}
		return new Value.ptr(typ, (ptr).$get(), fl);
	};
	Value.ptr.prototype.Method = function(i) {
		var fl, i, v;
		v = this;
		if (v.typ === ptrType$1.nil) {
			$panic(new ValueError.ptr("reflect.Value.Method", 0));
		}
		if (!((((v.flag & 512) >>> 0) === 0)) || ((i >>> 0)) >= ((v.typ.NumMethod() >>> 0))) {
			$panic(new $String("reflect: Method index out of range"));
		}
		if ((v.typ.Kind() === 20) && $clone(v, Value).IsNil()) {
			$panic(new $String("reflect: Method on nil interface value"));
		}
		fl = (new flag(v.flag).ro() | (((v.flag & 128) >>> 0))) >>> 0;
		fl = (fl | (19)) >>> 0;
		fl = (fl | ((((((i >>> 0)) << 10 >>> 0) | 512) >>> 0))) >>> 0;
		return new Value.ptr(v.typ, v.ptr, fl);
	};
	Value.prototype.Method = function(i) { return this.$val.Method(i); };
	Value.ptr.prototype.NumMethod = function() {
		var v;
		v = this;
		if (v.typ === ptrType$1.nil) {
			$panic(new ValueError.ptr("reflect.Value.NumMethod", 0));
		}
		if (!((((v.flag & 512) >>> 0) === 0))) {
			return 0;
		}
		return v.typ.NumMethod();
	};
	Value.prototype.NumMethod = function() { return this.$val.NumMethod(); };
	Value.ptr.prototype.MethodByName = function(name$1) {
		var {_r, _tuple, m, name$1, ok, v, $s, $r, $c} = $restore(this, {name$1});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		v = this;
		if (v.typ === ptrType$1.nil) {
			$panic(new ValueError.ptr("reflect.Value.MethodByName", 0));
		}
		if (!((((v.flag & 512) >>> 0) === 0))) {
			$s = -1; return new Value.ptr(ptrType$1.nil, 0, 0);
		}
		_r = v.typ.MethodByName(name$1); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		_tuple = _r;
		m = $clone(_tuple[0], Method);
		ok = _tuple[1];
		if (!ok) {
			$s = -1; return new Value.ptr(ptrType$1.nil, 0, 0);
		}
		$s = -1; return $clone(v, Value).Method(m.Index);
		/* */ } return; } var $f = {$blk: Value.ptr.prototype.MethodByName, $c: true, $r, _r, _tuple, m, name$1, ok, v, $s};return $f;
	};
	Value.prototype.MethodByName = function(name$1) { return this.$val.MethodByName(name$1); };
	Value.ptr.prototype.NumField = function() {
		var tt, v;
		v = this;
		new flag(v.flag).mustBe(25);
		tt = (v.typ.kindType);
		return tt.fields.$length;
	};
	Value.prototype.NumField = function() { return this.$val.NumField(); };
	Value.ptr.prototype.OverflowComplex = function(x) {
		var _1, k, v, x;
		v = this;
		k = new flag(v.flag).kind();
		_1 = k;
		if (_1 === (15)) {
			return overflowFloat32(x.$real) || overflowFloat32(x.$imag);
		} else if (_1 === (16)) {
			return false;
		}
		$panic(new ValueError.ptr("reflect.Value.OverflowComplex", new flag(v.flag).kind()));
	};
	Value.prototype.OverflowComplex = function(x) { return this.$val.OverflowComplex(x); };
	Value.ptr.prototype.OverflowFloat = function(x) {
		var _1, k, v, x;
		v = this;
		k = new flag(v.flag).kind();
		_1 = k;
		if (_1 === (13)) {
			return overflowFloat32(x);
		} else if (_1 === (14)) {
			return false;
		}
		$panic(new ValueError.ptr("reflect.Value.OverflowFloat", new flag(v.flag).kind()));
	};
	Value.prototype.OverflowFloat = function(x) { return this.$val.OverflowFloat(x); };
	overflowFloat32 = function(x) {
		var x;
		if (x < 0) {
			x = -x;
		}
		return 3.4028234663852886e+38 < x && x <= 1.7976931348623157e+308;
	};
	Value.ptr.prototype.OverflowInt = function(x) {
		var _1, bitSize, k, trunc, v, x;
		v = this;
		k = new flag(v.flag).kind();
		_1 = k;
		if ((_1 === (2)) || (_1 === (3)) || (_1 === (4)) || (_1 === (5)) || (_1 === (6))) {
			bitSize = $imul(v.typ.size, 8) >>> 0;
			trunc = $shiftRightInt64(($shiftLeft64(x, ((64 - bitSize >>> 0)))), ((64 - bitSize >>> 0)));
			return !((x.$high === trunc.$high && x.$low === trunc.$low));
		}
		$panic(new ValueError.ptr("reflect.Value.OverflowInt", new flag(v.flag).kind()));
	};
	Value.prototype.OverflowInt = function(x) { return this.$val.OverflowInt(x); };
	Value.ptr.prototype.OverflowUint = function(x) {
		var _1, bitSize, k, trunc, v, x;
		v = this;
		k = new flag(v.flag).kind();
		_1 = k;
		if ((_1 === (7)) || (_1 === (12)) || (_1 === (8)) || (_1 === (9)) || (_1 === (10)) || (_1 === (11))) {
			bitSize = $imul(v.typ.size, 8) >>> 0;
			trunc = $shiftRightUint64(($shiftLeft64(x, ((64 - bitSize >>> 0)))), ((64 - bitSize >>> 0)));
			return !((x.$high === trunc.$high && x.$low === trunc.$low));
		}
		$panic(new ValueError.ptr("reflect.Value.OverflowUint", new flag(v.flag).kind()));
	};
	Value.prototype.OverflowUint = function(x) { return this.$val.OverflowUint(x); };
	Value.ptr.prototype.Recv = function() {
		var {$24r, _r, _tuple, ok, v, x, $s, $r, $c} = $restore(this, {});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		x = new Value.ptr(ptrType$1.nil, 0, 0);
		ok = false;
		v = this;
		new flag(v.flag).mustBe(18);
		new flag(v.flag).mustBeExported();
		_r = $clone(v, Value).recv(false); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		_tuple = _r;
		x = _tuple[0];
		ok = _tuple[1];
		$24r = [x, ok];
		$s = 2; case 2: return $24r;
		/* */ } return; } var $f = {$blk: Value.ptr.prototype.Recv, $c: true, $r, $24r, _r, _tuple, ok, v, x, $s};return $f;
	};
	Value.prototype.Recv = function() { return this.$val.Recv(); };
	Value.ptr.prototype.recv = function(nb) {
		var {_r, _tuple, nb, ok, p, selected, t, tt, v, val, $s, $r, $c} = $restore(this, {nb});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		val = new Value.ptr(ptrType$1.nil, 0, 0);
		ok = false;
		v = this;
		tt = (v.typ.kindType);
		if ((((tt.dir >> 0)) & 1) === 0) {
			$panic(new $String("reflect: recv on send-only channel"));
		}
		t = tt.elem;
		val = new Value.ptr(t, 0, ((t.Kind() >>> 0)));
		p = 0;
		if (ifaceIndir(t)) {
			p = unsafe_New(t);
			val.ptr = p;
			val.flag = (val.flag | (128)) >>> 0;
		} else {
			p = ((val.$ptr_ptr || (val.$ptr_ptr = new ptrType$8(function() { return this.$target.ptr; }, function($v) { this.$target.ptr = $v; }, val))));
		}
		_r = chanrecv($clone(v, Value).pointer(), nb, p); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		_tuple = _r;
		selected = _tuple[0];
		ok = _tuple[1];
		if (!selected) {
			val = new Value.ptr(ptrType$1.nil, 0, 0);
		}
		$s = -1; return [val, ok];
		/* */ } return; } var $f = {$blk: Value.ptr.prototype.recv, $c: true, $r, _r, _tuple, nb, ok, p, selected, t, tt, v, val, $s};return $f;
	};
	Value.prototype.recv = function(nb) { return this.$val.recv(nb); };
	Value.ptr.prototype.Send = function(x) {
		var {_r, v, x, $s, $r, $c} = $restore(this, {x});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		v = this;
		new flag(v.flag).mustBe(18);
		new flag(v.flag).mustBeExported();
		_r = $clone(v, Value).send($clone(x, Value), false); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		_r;
		$s = -1; return;
		/* */ } return; } var $f = {$blk: Value.ptr.prototype.Send, $c: true, $r, _r, v, x, $s};return $f;
	};
	Value.prototype.Send = function(x) { return this.$val.Send(x); };
	Value.ptr.prototype.send = function(x, nb) {
		var {$24r, _r, _r$1, nb, p, selected, tt, v, x, $s, $r, $c} = $restore(this, {x, nb});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		selected = false;
		v = this;
		tt = (v.typ.kindType);
		if ((((tt.dir >> 0)) & 2) === 0) {
			$panic(new $String("reflect: send on recv-only channel"));
		}
		new flag(x.flag).mustBeExported();
		_r = $clone(x, Value).assignTo("reflect.Value.Send", tt.elem, 0); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		x = _r;
		p = 0;
		if (!((((x.flag & 128) >>> 0) === 0))) {
			p = x.ptr;
		} else {
			p = ((x.$ptr_ptr || (x.$ptr_ptr = new ptrType$8(function() { return this.$target.ptr; }, function($v) { this.$target.ptr = $v; }, x))));
		}
		_r$1 = chansend($clone(v, Value).pointer(), p, nb); /* */ $s = 2; case 2: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
		selected = _r$1;
		$24r = selected;
		$s = 3; case 3: return $24r;
		/* */ } return; } var $f = {$blk: Value.ptr.prototype.send, $c: true, $r, $24r, _r, _r$1, nb, p, selected, tt, v, x, $s};return $f;
	};
	Value.prototype.send = function(x, nb) { return this.$val.send(x, nb); };
	Value.ptr.prototype.SetBool = function(x) {
		var v, x;
		v = this;
		new flag(v.flag).mustBeAssignable();
		new flag(v.flag).mustBe(1);
		(v.ptr).$set(x);
	};
	Value.prototype.SetBool = function(x) { return this.$val.SetBool(x); };
	Value.ptr.prototype.setRunes = function(x) {
		var {_r, v, x, $s, $r, $c} = $restore(this, {x});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		v = this;
		new flag(v.flag).mustBeAssignable();
		new flag(v.flag).mustBe(23);
		_r = v.typ.Elem().Kind(); /* */ $s = 3; case 3: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		/* */ if (!((_r === 5))) { $s = 1; continue; }
		/* */ $s = 2; continue;
		/* if (!((_r === 5))) { */ case 1:
			$panic(new $String("reflect.Value.setRunes of non-rune slice"));
		/* } */ case 2:
		(v.ptr).$set(x);
		$s = -1; return;
		/* */ } return; } var $f = {$blk: Value.ptr.prototype.setRunes, $c: true, $r, _r, v, x, $s};return $f;
	};
	Value.prototype.setRunes = function(x) { return this.$val.setRunes(x); };
	Value.ptr.prototype.SetComplex = function(x) {
		var _1, k, v, x;
		v = this;
		new flag(v.flag).mustBeAssignable();
		k = new flag(v.flag).kind();
		_1 = k;
		if (_1 === (15)) {
			(v.ptr).$set((new $Complex64(x.$real, x.$imag)));
		} else if (_1 === (16)) {
			(v.ptr).$set(x);
		} else {
			$panic(new ValueError.ptr("reflect.Value.SetComplex", new flag(v.flag).kind()));
		}
	};
	Value.prototype.SetComplex = function(x) { return this.$val.SetComplex(x); };
	Value.ptr.prototype.SetFloat = function(x) {
		var _1, k, v, x;
		v = this;
		new flag(v.flag).mustBeAssignable();
		k = new flag(v.flag).kind();
		_1 = k;
		if (_1 === (13)) {
			(v.ptr).$set(($fround(x)));
		} else if (_1 === (14)) {
			(v.ptr).$set(x);
		} else {
			$panic(new ValueError.ptr("reflect.Value.SetFloat", new flag(v.flag).kind()));
		}
	};
	Value.prototype.SetFloat = function(x) { return this.$val.SetFloat(x); };
	Value.ptr.prototype.SetInt = function(x) {
		var _1, k, v, x;
		v = this;
		new flag(v.flag).mustBeAssignable();
		k = new flag(v.flag).kind();
		_1 = k;
		if (_1 === (2)) {
			(v.ptr).$set((((x.$low + ((x.$high >> 31) * 4294967296)) >> 0)));
		} else if (_1 === (3)) {
			(v.ptr).$set((((x.$low + ((x.$high >> 31) * 4294967296)) << 24 >> 24)));
		} else if (_1 === (4)) {
			(v.ptr).$set((((x.$low + ((x.$high >> 31) * 4294967296)) << 16 >> 16)));
		} else if (_1 === (5)) {
			(v.ptr).$set((((x.$low + ((x.$high >> 31) * 4294967296)) >> 0)));
		} else if (_1 === (6)) {
			(v.ptr).$set(x);
		} else {
			$panic(new ValueError.ptr("reflect.Value.SetInt", new flag(v.flag).kind()));
		}
	};
	Value.prototype.SetInt = function(x) { return this.$val.SetInt(x); };
	Value.ptr.prototype.SetMapIndex = function(key, elem) {
		var {_r, _r$1, _r$2, e, e$1, elem, k, k$1, key, tt, v, $s, $r, $c} = $restore(this, {key, elem});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		v = this;
		new flag(v.flag).mustBe(21);
		new flag(v.flag).mustBeExported();
		new flag(key.flag).mustBeExported();
		tt = (v.typ.kindType);
		/* */ if ((tt.key === stringType || (new flag(key.flag).kind() === 24)) && tt.key === key.typ && tt.elem.size <= 128) { $s = 1; continue; }
		/* */ $s = 2; continue;
		/* if ((tt.key === stringType || (new flag(key.flag).kind() === 24)) && tt.key === key.typ && tt.elem.size <= 128) { */ case 1:
			k = (key.ptr).$get();
			if (elem.typ === ptrType$1.nil) {
				mapdelete_faststr(v.typ, $clone(v, Value).pointer(), k);
				$s = -1; return;
			}
			new flag(elem.flag).mustBeExported();
			_r = $clone(elem, Value).assignTo("reflect.Value.SetMapIndex", tt.elem, 0); /* */ $s = 3; case 3: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
			elem = _r;
			e = 0;
			if (!((((elem.flag & 128) >>> 0) === 0))) {
				e = elem.ptr;
			} else {
				e = ((elem.$ptr_ptr || (elem.$ptr_ptr = new ptrType$8(function() { return this.$target.ptr; }, function($v) { this.$target.ptr = $v; }, elem))));
			}
			$r = mapassign_faststr(v.typ, $clone(v, Value).pointer(), k, e); /* */ $s = 4; case 4: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
			$s = -1; return;
		/* } */ case 2:
		_r$1 = $clone(key, Value).assignTo("reflect.Value.SetMapIndex", tt.key, 0); /* */ $s = 5; case 5: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
		key = _r$1;
		k$1 = 0;
		if (!((((key.flag & 128) >>> 0) === 0))) {
			k$1 = key.ptr;
		} else {
			k$1 = ((key.$ptr_ptr || (key.$ptr_ptr = new ptrType$8(function() { return this.$target.ptr; }, function($v) { this.$target.ptr = $v; }, key))));
		}
		if (elem.typ === ptrType$1.nil) {
			mapdelete(v.typ, $clone(v, Value).pointer(), k$1);
			$s = -1; return;
		}
		new flag(elem.flag).mustBeExported();
		_r$2 = $clone(elem, Value).assignTo("reflect.Value.SetMapIndex", tt.elem, 0); /* */ $s = 6; case 6: if($c) { $c = false; _r$2 = _r$2.$blk(); } if (_r$2 && _r$2.$blk !== undefined) { break s; }
		elem = _r$2;
		e$1 = 0;
		if (!((((elem.flag & 128) >>> 0) === 0))) {
			e$1 = elem.ptr;
		} else {
			e$1 = ((elem.$ptr_ptr || (elem.$ptr_ptr = new ptrType$8(function() { return this.$target.ptr; }, function($v) { this.$target.ptr = $v; }, elem))));
		}
		$r = mapassign(v.typ, $clone(v, Value).pointer(), k$1, e$1); /* */ $s = 7; case 7: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$s = -1; return;
		/* */ } return; } var $f = {$blk: Value.ptr.prototype.SetMapIndex, $c: true, $r, _r, _r$1, _r$2, e, e$1, elem, k, k$1, key, tt, v, $s};return $f;
	};
	Value.prototype.SetMapIndex = function(key, elem) { return this.$val.SetMapIndex(key, elem); };
	Value.ptr.prototype.SetUint = function(x) {
		var _1, k, v, x;
		v = this;
		new flag(v.flag).mustBeAssignable();
		k = new flag(v.flag).kind();
		_1 = k;
		if (_1 === (7)) {
			(v.ptr).$set(((x.$low >>> 0)));
		} else if (_1 === (8)) {
			(v.ptr).$set(((x.$low << 24 >>> 24)));
		} else if (_1 === (9)) {
			(v.ptr).$set(((x.$low << 16 >>> 16)));
		} else if (_1 === (10)) {
			(v.ptr).$set(((x.$low >>> 0)));
		} else if (_1 === (11)) {
			(v.ptr).$set(x);
		} else if (_1 === (12)) {
			(v.ptr).$set(((x.$low >>> 0)));
		} else {
			$panic(new ValueError.ptr("reflect.Value.SetUint", new flag(v.flag).kind()));
		}
	};
	Value.prototype.SetUint = function(x) { return this.$val.SetUint(x); };
	Value.ptr.prototype.SetPointer = function(x) {
		var v, x;
		v = this;
		new flag(v.flag).mustBeAssignable();
		new flag(v.flag).mustBe(26);
		(v.ptr).$set(x);
	};
	Value.prototype.SetPointer = function(x) { return this.$val.SetPointer(x); };
	Value.ptr.prototype.SetString = function(x) {
		var v, x;
		v = this;
		new flag(v.flag).mustBeAssignable();
		new flag(v.flag).mustBe(24);
		(v.ptr).$set(x);
	};
	Value.prototype.SetString = function(x) { return this.$val.SetString(x); };
	Value.ptr.prototype.String = function() {
		var {$24r, _r, v, $s, $r, $c} = $restore(this, {});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		v = this;
		if (new flag(v.flag).kind() === 24) {
			$s = -1; return (v.ptr).$get();
		}
		_r = $clone(v, Value).stringNonString(); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		$24r = _r;
		$s = 2; case 2: return $24r;
		/* */ } return; } var $f = {$blk: Value.ptr.prototype.String, $c: true, $r, $24r, _r, v, $s};return $f;
	};
	Value.prototype.String = function() { return this.$val.String(); };
	Value.ptr.prototype.stringNonString = function() {
		var {$24r, _r, v, $s, $r, $c} = $restore(this, {});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		v = this;
		if (new flag(v.flag).kind() === 0) {
			$s = -1; return "<invalid Value>";
		}
		_r = $clone(v, Value).Type().String(); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		$24r = "<" + _r + " Value>";
		$s = 2; case 2: return $24r;
		/* */ } return; } var $f = {$blk: Value.ptr.prototype.stringNonString, $c: true, $r, $24r, _r, v, $s};return $f;
	};
	Value.prototype.stringNonString = function() { return this.$val.stringNonString(); };
	Value.ptr.prototype.TryRecv = function() {
		var {$24r, _r, _tuple, ok, v, x, $s, $r, $c} = $restore(this, {});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		x = new Value.ptr(ptrType$1.nil, 0, 0);
		ok = false;
		v = this;
		new flag(v.flag).mustBe(18);
		new flag(v.flag).mustBeExported();
		_r = $clone(v, Value).recv(true); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		_tuple = _r;
		x = _tuple[0];
		ok = _tuple[1];
		$24r = [x, ok];
		$s = 2; case 2: return $24r;
		/* */ } return; } var $f = {$blk: Value.ptr.prototype.TryRecv, $c: true, $r, $24r, _r, _tuple, ok, v, x, $s};return $f;
	};
	Value.prototype.TryRecv = function() { return this.$val.TryRecv(); };
	Value.ptr.prototype.TrySend = function(x) {
		var {$24r, _r, v, x, $s, $r, $c} = $restore(this, {x});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		v = this;
		new flag(v.flag).mustBe(18);
		new flag(v.flag).mustBeExported();
		_r = $clone(v, Value).send($clone(x, Value), true); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		$24r = _r;
		$s = 2; case 2: return $24r;
		/* */ } return; } var $f = {$blk: Value.ptr.prototype.TrySend, $c: true, $r, $24r, _r, v, x, $s};return $f;
	};
	Value.prototype.TrySend = function(x) { return this.$val.TrySend(x); };
	Value.ptr.prototype.Type = function() {
		var v;
		v = this;
		if (!((v.flag === 0)) && (((v.flag & 512) >>> 0) === 0)) {
			return v.typ;
		}
		return $clone(v, Value).typeSlow();
	};
	Value.prototype.Type = function() { return this.$val.Type(); };
	Value.ptr.prototype.typeSlow = function() {
		var i, m, m$1, ms, tt, v, x;
		v = this;
		if (v.flag === 0) {
			$panic(new ValueError.ptr("reflect.Value.Type", 0));
		}
		if (((v.flag & 512) >>> 0) === 0) {
			return v.typ;
		}
		i = ((v.flag >> 0)) >> 10 >> 0;
		if (v.typ.Kind() === 20) {
			tt = (v.typ.kindType);
			if (((i >>> 0)) >= ((tt.methods.$length >>> 0))) {
				$panic(new $String("reflect: internal error: invalid method index"));
			}
			m = (x = tt.methods, ((i < 0 || i >= x.$length) ? ($throwRuntimeError("index out of range"), undefined) : x.$array[x.$offset + i]));
			return v.typ.typeOff(m.typ);
		}
		ms = v.typ.exportedMethods();
		if (((i >>> 0)) >= ((ms.$length >>> 0))) {
			$panic(new $String("reflect: internal error: invalid method index"));
		}
		m$1 = $clone(((i < 0 || i >= ms.$length) ? ($throwRuntimeError("index out of range"), undefined) : ms.$array[ms.$offset + i]), method);
		return v.typ.typeOff(m$1.mtyp);
	};
	Value.prototype.typeSlow = function() { return this.$val.typeSlow(); };
	Value.ptr.prototype.CanUint = function() {
		var _1, v;
		v = this;
		_1 = new flag(v.flag).kind();
		if ((_1 === (7)) || (_1 === (8)) || (_1 === (9)) || (_1 === (10)) || (_1 === (11)) || (_1 === (12))) {
			return true;
		} else {
			return false;
		}
	};
	Value.prototype.CanUint = function() { return this.$val.CanUint(); };
	Value.ptr.prototype.Uint = function() {
		var _1, k, p, v, x;
		v = this;
		k = new flag(v.flag).kind();
		p = v.ptr;
		_1 = k;
		if (_1 === (7)) {
			return (new $Uint64(0, (p).$get()));
		} else if (_1 === (8)) {
			return (new $Uint64(0, (p).$get()));
		} else if (_1 === (9)) {
			return (new $Uint64(0, (p).$get()));
		} else if (_1 === (10)) {
			return (new $Uint64(0, (p).$get()));
		} else if (_1 === (11)) {
			return (p).$get();
		} else if (_1 === (12)) {
			return ((x = (p).$get(), new $Uint64(0, x.constructor === Number ? x : 1)));
		}
		$panic(new ValueError.ptr("reflect.Value.Uint", new flag(v.flag).kind()));
	};
	Value.prototype.Uint = function() { return this.$val.Uint(); };
	Value.ptr.prototype.UnsafeAddr = function() {
		var v;
		v = this;
		if (v.typ === ptrType$1.nil) {
			$panic(new ValueError.ptr("reflect.Value.UnsafeAddr", 0));
		}
		if (((v.flag & 256) >>> 0) === 0) {
			$panic(new $String("reflect.Value.UnsafeAddr of unaddressable value"));
		}
		return (v.ptr);
	};
	Value.prototype.UnsafeAddr = function() { return this.$val.UnsafeAddr(); };
	Value.ptr.prototype.UnsafePointer = function() {
		var {_1, _r, code, k, p, v, $s, $r, $c} = $restore(this, {});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		code = [code];
		v = this;
		k = new flag(v.flag).kind();
			_1 = k;
			/* */ if (_1 === (22)) { $s = 2; continue; }
			/* */ if ((_1 === (18)) || (_1 === (21)) || (_1 === (26))) { $s = 3; continue; }
			/* */ if (_1 === (19)) { $s = 4; continue; }
			/* */ if (_1 === (23)) { $s = 5; continue; }
			/* */ $s = 6; continue;
			/* if (_1 === (22)) { */ case 2:
				if (v.typ.ptrdata === 0) {
					if (!verifyNotInHeapPtr((v.ptr).$get())) {
						$panic(new $String("reflect: reflect.Value.UnsafePointer on an invalid notinheap pointer"));
					}
					$s = -1; return (v.ptr).$get();
				}
				$s = -1; return $clone(v, Value).pointer();
			/* } else if ((_1 === (18)) || (_1 === (21)) || (_1 === (26))) { */ case 3:
				$s = -1; return $clone(v, Value).pointer();
			/* } else if (_1 === (19)) { */ case 4:
				/* */ if (!((((v.flag & 512) >>> 0) === 0))) { $s = 7; continue; }
				/* */ $s = 8; continue;
				/* if (!((((v.flag & 512) >>> 0) === 0))) { */ case 7:
					_r = methodValueCallCodePtr(); /* */ $s = 9; case 9: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
					code[0] = _r;
					$s = -1; return code[0];
				/* } */ case 8:
				p = $clone(v, Value).pointer();
				if (!(p === 0)) {
					p = (p).$get();
				}
				$s = -1; return p;
			/* } else if (_1 === (23)) { */ case 5:
				$s = -1; return ($pointerOfStructConversion(v.ptr, ptrType$9)).Data;
			/* } */ case 6:
		case 1:
		$panic(new ValueError.ptr("reflect.Value.UnsafePointer", new flag(v.flag).kind()));
		$s = -1; return 0;
		/* */ } return; } var $f = {$blk: Value.ptr.prototype.UnsafePointer, $c: true, $r, _1, _r, code, k, p, v, $s};return $f;
	};
	Value.prototype.UnsafePointer = function() { return this.$val.UnsafePointer(); };
	Value.ptr.prototype.Convert = function(t) {
		var {$24r, _r, _r$1, _r$2, _r$3, _r$4, op, t, v, $s, $r, $c} = $restore(this, {t});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		v = this;
		/* */ if (!((((v.flag & 512) >>> 0) === 0))) { $s = 1; continue; }
		/* */ $s = 2; continue;
		/* if (!((((v.flag & 512) >>> 0) === 0))) { */ case 1:
			_r = makeMethodValue("Convert", $clone(v, Value)); /* */ $s = 3; case 3: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
			v = _r;
		/* } */ case 2:
		_r$1 = t.common(); /* */ $s = 4; case 4: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
		_r$2 = convertOp(_r$1, v.typ); /* */ $s = 5; case 5: if($c) { $c = false; _r$2 = _r$2.$blk(); } if (_r$2 && _r$2.$blk !== undefined) { break s; }
		op = _r$2;
		/* */ if (op === $throwNilPointerError) { $s = 6; continue; }
		/* */ $s = 7; continue;
		/* if (op === $throwNilPointerError) { */ case 6:
			_r$3 = t.String(); /* */ $s = 8; case 8: if($c) { $c = false; _r$3 = _r$3.$blk(); } if (_r$3 && _r$3.$blk !== undefined) { break s; }
			$panic(new $String("reflect.Value.Convert: value of type " + v.typ.String() + " cannot be converted to type " + _r$3));
		/* } */ case 7:
		_r$4 = op($clone(v, Value), t); /* */ $s = 9; case 9: if($c) { $c = false; _r$4 = _r$4.$blk(); } if (_r$4 && _r$4.$blk !== undefined) { break s; }
		$24r = _r$4;
		$s = 10; case 10: return $24r;
		/* */ } return; } var $f = {$blk: Value.ptr.prototype.Convert, $c: true, $r, $24r, _r, _r$1, _r$2, _r$3, _r$4, op, t, v, $s};return $f;
	};
	Value.prototype.Convert = function(t) { return this.$val.Convert(t); };
	Value.ptr.prototype.CanConvert = function(t) {
		var {_r, _r$1, _r$2, _r$3, _r$4, _r$5, _r$6, _r$7, _v, _v$1, n, t, v, vt, $s, $r, $c} = $restore(this, {t});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		v = this;
		vt = $clone(v, Value).Type();
		_r = vt.ConvertibleTo(t); /* */ $s = 3; case 3: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		/* */ if (!_r) { $s = 1; continue; }
		/* */ $s = 2; continue;
		/* if (!_r) { */ case 1:
			$s = -1; return false;
		/* } */ case 2:
		_r$1 = vt.Kind(); /* */ $s = 8; case 8: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
		if (!(_r$1 === 23)) { _v$1 = false; $s = 7; continue s; }
		_r$2 = t.Kind(); /* */ $s = 9; case 9: if($c) { $c = false; _r$2 = _r$2.$blk(); } if (_r$2 && _r$2.$blk !== undefined) { break s; }
		_v$1 = _r$2 === 22; case 7:
		if (!(_v$1)) { _v = false; $s = 6; continue s; }
		_r$3 = t.Elem(); /* */ $s = 10; case 10: if($c) { $c = false; _r$3 = _r$3.$blk(); } if (_r$3 && _r$3.$blk !== undefined) { break s; }
		_r$4 = _r$3.Kind(); /* */ $s = 11; case 11: if($c) { $c = false; _r$4 = _r$4.$blk(); } if (_r$4 && _r$4.$blk !== undefined) { break s; }
		_v = _r$4 === 17; case 6:
		/* */ if (_v) { $s = 4; continue; }
		/* */ $s = 5; continue;
		/* if (_v) { */ case 4:
			_r$5 = t.Elem(); /* */ $s = 12; case 12: if($c) { $c = false; _r$5 = _r$5.$blk(); } if (_r$5 && _r$5.$blk !== undefined) { break s; }
			_r$6 = _r$5.Len(); /* */ $s = 13; case 13: if($c) { $c = false; _r$6 = _r$6.$blk(); } if (_r$6 && _r$6.$blk !== undefined) { break s; }
			n = _r$6;
			_r$7 = $clone(v, Value).Len(); /* */ $s = 16; case 16: if($c) { $c = false; _r$7 = _r$7.$blk(); } if (_r$7 && _r$7.$blk !== undefined) { break s; }
			/* */ if (n > _r$7) { $s = 14; continue; }
			/* */ $s = 15; continue;
			/* if (n > _r$7) { */ case 14:
				$s = -1; return false;
			/* } */ case 15:
		/* } */ case 5:
		$s = -1; return true;
		/* */ } return; } var $f = {$blk: Value.ptr.prototype.CanConvert, $c: true, $r, _r, _r$1, _r$2, _r$3, _r$4, _r$5, _r$6, _r$7, _v, _v$1, n, t, v, vt, $s};return $f;
	};
	Value.prototype.CanConvert = function(t) { return this.$val.CanConvert(t); };
	convertOp = function(dst, src) {
		var {_1, _2, _3, _4, _5, _6, _7, _arg, _arg$1, _r, _r$1, _r$10, _r$2, _r$3, _r$4, _r$5, _r$6, _r$7, _r$8, _r$9, _v, _v$1, _v$2, _v$3, _v$4, _v$5, dst, src, $s, $r, $c} = $restore(this, {dst, src});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
			_1 = src.Kind();
			/* */ if ((_1 === (2)) || (_1 === (3)) || (_1 === (4)) || (_1 === (5)) || (_1 === (6))) { $s = 2; continue; }
			/* */ if ((_1 === (7)) || (_1 === (8)) || (_1 === (9)) || (_1 === (10)) || (_1 === (11)) || (_1 === (12))) { $s = 3; continue; }
			/* */ if ((_1 === (13)) || (_1 === (14))) { $s = 4; continue; }
			/* */ if ((_1 === (15)) || (_1 === (16))) { $s = 5; continue; }
			/* */ if (_1 === (24)) { $s = 6; continue; }
			/* */ if (_1 === (23)) { $s = 7; continue; }
			/* */ if (_1 === (18)) { $s = 8; continue; }
			/* */ $s = 9; continue;
			/* if ((_1 === (2)) || (_1 === (3)) || (_1 === (4)) || (_1 === (5)) || (_1 === (6))) { */ case 2:
				_2 = dst.Kind();
				if ((_2 === (2)) || (_2 === (3)) || (_2 === (4)) || (_2 === (5)) || (_2 === (6)) || (_2 === (7)) || (_2 === (8)) || (_2 === (9)) || (_2 === (10)) || (_2 === (11)) || (_2 === (12))) {
					$s = -1; return cvtInt;
				} else if ((_2 === (13)) || (_2 === (14))) {
					$s = -1; return cvtIntFloat;
				} else if (_2 === (24)) {
					$s = -1; return cvtIntString;
				}
				$s = 9; continue;
			/* } else if ((_1 === (7)) || (_1 === (8)) || (_1 === (9)) || (_1 === (10)) || (_1 === (11)) || (_1 === (12))) { */ case 3:
				_3 = dst.Kind();
				if ((_3 === (2)) || (_3 === (3)) || (_3 === (4)) || (_3 === (5)) || (_3 === (6)) || (_3 === (7)) || (_3 === (8)) || (_3 === (9)) || (_3 === (10)) || (_3 === (11)) || (_3 === (12))) {
					$s = -1; return cvtUint;
				} else if ((_3 === (13)) || (_3 === (14))) {
					$s = -1; return cvtUintFloat;
				} else if (_3 === (24)) {
					$s = -1; return cvtUintString;
				}
				$s = 9; continue;
			/* } else if ((_1 === (13)) || (_1 === (14))) { */ case 4:
				_4 = dst.Kind();
				if ((_4 === (2)) || (_4 === (3)) || (_4 === (4)) || (_4 === (5)) || (_4 === (6))) {
					$s = -1; return cvtFloatInt;
				} else if ((_4 === (7)) || (_4 === (8)) || (_4 === (9)) || (_4 === (10)) || (_4 === (11)) || (_4 === (12))) {
					$s = -1; return cvtFloatUint;
				} else if ((_4 === (13)) || (_4 === (14))) {
					$s = -1; return cvtFloat;
				}
				$s = 9; continue;
			/* } else if ((_1 === (15)) || (_1 === (16))) { */ case 5:
				_5 = dst.Kind();
				if ((_5 === (15)) || (_5 === (16))) {
					$s = -1; return cvtComplex;
				}
				$s = 9; continue;
			/* } else if (_1 === (24)) { */ case 6:
				if (!(dst.Kind() === 23)) { _v = false; $s = 12; continue s; }
				_r = dst.Elem().PkgPath(); /* */ $s = 13; case 13: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
				_v = _r === ""; case 12:
				/* */ if (_v) { $s = 10; continue; }
				/* */ $s = 11; continue;
				/* if (_v) { */ case 10:
						_r$1 = dst.Elem().Kind(); /* */ $s = 15; case 15: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
						_6 = _r$1;
						if (_6 === (8)) {
							$s = -1; return cvtStringBytes;
						} else if (_6 === (5)) {
							$s = -1; return cvtStringRunes;
						}
					case 14:
				/* } */ case 11:
				$s = 9; continue;
			/* } else if (_1 === (23)) { */ case 7:
				if (!(dst.Kind() === 24)) { _v$1 = false; $s = 18; continue s; }
				_r$2 = src.Elem().PkgPath(); /* */ $s = 19; case 19: if($c) { $c = false; _r$2 = _r$2.$blk(); } if (_r$2 && _r$2.$blk !== undefined) { break s; }
				_v$1 = _r$2 === ""; case 18:
				/* */ if (_v$1) { $s = 16; continue; }
				/* */ $s = 17; continue;
				/* if (_v$1) { */ case 16:
						_r$3 = src.Elem().Kind(); /* */ $s = 21; case 21: if($c) { $c = false; _r$3 = _r$3.$blk(); } if (_r$3 && _r$3.$blk !== undefined) { break s; }
						_7 = _r$3;
						if (_7 === (8)) {
							$s = -1; return cvtBytesString;
						} else if (_7 === (5)) {
							$s = -1; return cvtRunesString;
						}
					case 20:
				/* } */ case 17:
				if (!(dst.Kind() === 22)) { _v$3 = false; $s = 25; continue s; }
				_r$4 = dst.Elem().Kind(); /* */ $s = 26; case 26: if($c) { $c = false; _r$4 = _r$4.$blk(); } if (_r$4 && _r$4.$blk !== undefined) { break s; }
				_v$3 = _r$4 === 17; case 25:
				if (!(_v$3)) { _v$2 = false; $s = 24; continue s; }
				_r$5 = dst.Elem().Elem(); /* */ $s = 27; case 27: if($c) { $c = false; _r$5 = _r$5.$blk(); } if (_r$5 && _r$5.$blk !== undefined) { break s; }
				_v$2 = $interfaceIsEqual(src.Elem(), _r$5); case 24:
				/* */ if (_v$2) { $s = 22; continue; }
				/* */ $s = 23; continue;
				/* if (_v$2) { */ case 22:
					$s = -1; return cvtSliceArrayPtr;
				/* } */ case 23:
				$s = 9; continue;
			/* } else if (_1 === (18)) { */ case 8:
				if (!(dst.Kind() === 18)) { _v$4 = false; $s = 30; continue s; }
				_r$6 = specialChannelAssignability(dst, src); /* */ $s = 31; case 31: if($c) { $c = false; _r$6 = _r$6.$blk(); } if (_r$6 && _r$6.$blk !== undefined) { break s; }
				_v$4 = _r$6; case 30:
				/* */ if (_v$4) { $s = 28; continue; }
				/* */ $s = 29; continue;
				/* if (_v$4) { */ case 28:
					$s = -1; return cvtDirect;
				/* } */ case 29:
			/* } */ case 9:
		case 1:
		_r$7 = haveIdenticalUnderlyingType(dst, src, false); /* */ $s = 34; case 34: if($c) { $c = false; _r$7 = _r$7.$blk(); } if (_r$7 && _r$7.$blk !== undefined) { break s; }
		/* */ if (_r$7) { $s = 32; continue; }
		/* */ $s = 33; continue;
		/* if (_r$7) { */ case 32:
			$s = -1; return cvtDirect;
		/* } */ case 33:
		if (!((dst.Kind() === 22) && dst.Name() === "" && (src.Kind() === 22) && src.Name() === "")) { _v$5 = false; $s = 37; continue s; }
		_r$8 = dst.Elem().common(); /* */ $s = 38; case 38: if($c) { $c = false; _r$8 = _r$8.$blk(); } if (_r$8 && _r$8.$blk !== undefined) { break s; }
		_arg = _r$8;
		_r$9 = src.Elem().common(); /* */ $s = 39; case 39: if($c) { $c = false; _r$9 = _r$9.$blk(); } if (_r$9 && _r$9.$blk !== undefined) { break s; }
		_arg$1 = _r$9;
		_r$10 = haveIdenticalUnderlyingType(_arg, _arg$1, false); /* */ $s = 40; case 40: if($c) { $c = false; _r$10 = _r$10.$blk(); } if (_r$10 && _r$10.$blk !== undefined) { break s; }
		_v$5 = _r$10; case 37:
		/* */ if (_v$5) { $s = 35; continue; }
		/* */ $s = 36; continue;
		/* if (_v$5) { */ case 35:
			$s = -1; return cvtDirect;
		/* } */ case 36:
		if (implements$1(dst, src)) {
			if (src.Kind() === 20) {
				$s = -1; return cvtI2I;
			}
			$s = -1; return cvtT2I;
		}
		$s = -1; return $throwNilPointerError;
		/* */ } return; } var $f = {$blk: convertOp, $c: true, $r, _1, _2, _3, _4, _5, _6, _7, _arg, _arg$1, _r, _r$1, _r$10, _r$2, _r$3, _r$4, _r$5, _r$6, _r$7, _r$8, _r$9, _v, _v$1, _v$2, _v$3, _v$4, _v$5, dst, src, $s};return $f;
	};
	makeFloat = function(f, v, t) {
		var {_1, _r, f, ptr, t, typ, v, $s, $r, $c} = $restore(this, {f, v, t});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		_r = t.common(); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		typ = _r;
		ptr = unsafe_New(typ);
		_1 = typ.size;
		if (_1 === (4)) {
			(ptr).$set(($fround(v)));
		} else if (_1 === (8)) {
			(ptr).$set(v);
		}
		$s = -1; return new Value.ptr(typ, ptr, (((f | 128) >>> 0) | ((typ.Kind() >>> 0))) >>> 0);
		/* */ } return; } var $f = {$blk: makeFloat, $c: true, $r, _1, _r, f, ptr, t, typ, v, $s};return $f;
	};
	makeFloat32 = function(f, v, t) {
		var {_r, f, ptr, t, typ, v, $s, $r, $c} = $restore(this, {f, v, t});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		_r = t.common(); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		typ = _r;
		ptr = unsafe_New(typ);
		(ptr).$set(v);
		$s = -1; return new Value.ptr(typ, ptr, (((f | 128) >>> 0) | ((typ.Kind() >>> 0))) >>> 0);
		/* */ } return; } var $f = {$blk: makeFloat32, $c: true, $r, _r, f, ptr, t, typ, v, $s};return $f;
	};
	makeComplex = function(f, v, t) {
		var {_1, _r, f, ptr, t, typ, v, $s, $r, $c} = $restore(this, {f, v, t});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		_r = t.common(); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		typ = _r;
		ptr = unsafe_New(typ);
		_1 = typ.size;
		if (_1 === (8)) {
			(ptr).$set((new $Complex64(v.$real, v.$imag)));
		} else if (_1 === (16)) {
			(ptr).$set(v);
		}
		$s = -1; return new Value.ptr(typ, ptr, (((f | 128) >>> 0) | ((typ.Kind() >>> 0))) >>> 0);
		/* */ } return; } var $f = {$blk: makeComplex, $c: true, $r, _1, _r, f, ptr, t, typ, v, $s};return $f;
	};
	makeString = function(f, v, t) {
		var {_r, f, ret, t, v, $s, $r, $c} = $restore(this, {f, v, t});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		_r = $clone(New(t), Value).Elem(); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		ret = _r;
		$clone(ret, Value).SetString(v);
		ret.flag = (((ret.flag & ~256) >>> 0) | f) >>> 0;
		$s = -1; return ret;
		/* */ } return; } var $f = {$blk: makeString, $c: true, $r, _r, f, ret, t, v, $s};return $f;
	};
	makeBytes = function(f, v, t) {
		var {_r, f, ret, t, v, $s, $r, $c} = $restore(this, {f, v, t});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		_r = $clone(New(t), Value).Elem(); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		ret = _r;
		$r = $clone(ret, Value).SetBytes(v); /* */ $s = 2; case 2: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		ret.flag = (((ret.flag & ~256) >>> 0) | f) >>> 0;
		$s = -1; return ret;
		/* */ } return; } var $f = {$blk: makeBytes, $c: true, $r, _r, f, ret, t, v, $s};return $f;
	};
	makeRunes = function(f, v, t) {
		var {_r, f, ret, t, v, $s, $r, $c} = $restore(this, {f, v, t});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		_r = $clone(New(t), Value).Elem(); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		ret = _r;
		$r = $clone(ret, Value).setRunes(v); /* */ $s = 2; case 2: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		ret.flag = (((ret.flag & ~256) >>> 0) | f) >>> 0;
		$s = -1; return ret;
		/* */ } return; } var $f = {$blk: makeRunes, $c: true, $r, _r, f, ret, t, v, $s};return $f;
	};
	cvtInt = function(v, t) {
		var {$24r, _r, t, v, x, $s, $r, $c} = $restore(this, {v, t});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		_r = makeInt(new flag(v.flag).ro(), ((x = $clone(v, Value).Int(), new $Uint64(x.$high, x.$low))), t); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		$24r = _r;
		$s = 2; case 2: return $24r;
		/* */ } return; } var $f = {$blk: cvtInt, $c: true, $r, $24r, _r, t, v, x, $s};return $f;
	};
	cvtUint = function(v, t) {
		var {$24r, _r, t, v, $s, $r, $c} = $restore(this, {v, t});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		_r = makeInt(new flag(v.flag).ro(), $clone(v, Value).Uint(), t); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		$24r = _r;
		$s = 2; case 2: return $24r;
		/* */ } return; } var $f = {$blk: cvtUint, $c: true, $r, $24r, _r, t, v, $s};return $f;
	};
	cvtFloatInt = function(v, t) {
		var {$24r, _r, t, v, x, $s, $r, $c} = $restore(this, {v, t});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		_r = makeInt(new flag(v.flag).ro(), ((x = (new $Int64(0, $clone(v, Value).Float())), new $Uint64(x.$high, x.$low))), t); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		$24r = _r;
		$s = 2; case 2: return $24r;
		/* */ } return; } var $f = {$blk: cvtFloatInt, $c: true, $r, $24r, _r, t, v, x, $s};return $f;
	};
	cvtFloatUint = function(v, t) {
		var {$24r, _r, t, v, $s, $r, $c} = $restore(this, {v, t});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		_r = makeInt(new flag(v.flag).ro(), (new $Uint64(0, $clone(v, Value).Float())), t); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		$24r = _r;
		$s = 2; case 2: return $24r;
		/* */ } return; } var $f = {$blk: cvtFloatUint, $c: true, $r, $24r, _r, t, v, $s};return $f;
	};
	cvtIntFloat = function(v, t) {
		var {$24r, _r, t, v, $s, $r, $c} = $restore(this, {v, t});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		_r = makeFloat(new flag(v.flag).ro(), ($flatten64($clone(v, Value).Int())), t); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		$24r = _r;
		$s = 2; case 2: return $24r;
		/* */ } return; } var $f = {$blk: cvtIntFloat, $c: true, $r, $24r, _r, t, v, $s};return $f;
	};
	cvtUintFloat = function(v, t) {
		var {$24r, _r, t, v, $s, $r, $c} = $restore(this, {v, t});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		_r = makeFloat(new flag(v.flag).ro(), ($flatten64($clone(v, Value).Uint())), t); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		$24r = _r;
		$s = 2; case 2: return $24r;
		/* */ } return; } var $f = {$blk: cvtUintFloat, $c: true, $r, $24r, _r, t, v, $s};return $f;
	};
	cvtFloat = function(v, t) {
		var {$24r, $24r$1, _r, _r$1, _r$2, _r$3, _v, t, v, $s, $r, $c} = $restore(this, {v, t});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		_r = $clone(v, Value).Type().Kind(); /* */ $s = 4; case 4: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		if (!(_r === 13)) { _v = false; $s = 3; continue s; }
		_r$1 = t.Kind(); /* */ $s = 5; case 5: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
		_v = _r$1 === 13; case 3:
		/* */ if (_v) { $s = 1; continue; }
		/* */ $s = 2; continue;
		/* if (_v) { */ case 1:
			_r$2 = makeFloat32(new flag(v.flag).ro(), (v.ptr).$get(), t); /* */ $s = 6; case 6: if($c) { $c = false; _r$2 = _r$2.$blk(); } if (_r$2 && _r$2.$blk !== undefined) { break s; }
			$24r = _r$2;
			$s = 7; case 7: return $24r;
		/* } */ case 2:
		_r$3 = makeFloat(new flag(v.flag).ro(), $clone(v, Value).Float(), t); /* */ $s = 8; case 8: if($c) { $c = false; _r$3 = _r$3.$blk(); } if (_r$3 && _r$3.$blk !== undefined) { break s; }
		$24r$1 = _r$3;
		$s = 9; case 9: return $24r$1;
		/* */ } return; } var $f = {$blk: cvtFloat, $c: true, $r, $24r, $24r$1, _r, _r$1, _r$2, _r$3, _v, t, v, $s};return $f;
	};
	cvtComplex = function(v, t) {
		var {$24r, _r, t, v, $s, $r, $c} = $restore(this, {v, t});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		_r = makeComplex(new flag(v.flag).ro(), $clone(v, Value).Complex(), t); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		$24r = _r;
		$s = 2; case 2: return $24r;
		/* */ } return; } var $f = {$blk: cvtComplex, $c: true, $r, $24r, _r, t, v, $s};return $f;
	};
	cvtIntString = function(v, t) {
		var {$24r, _r, s, t, v, x, x$1, $s, $r, $c} = $restore(this, {v, t});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		s = "\xEF\xBF\xBD";
		x = $clone(v, Value).Int();
		if ((x$1 = (new $Int64(0, (((x.$low + ((x.$high >> 31) * 4294967296)) >> 0)))), (x$1.$high === x.$high && x$1.$low === x.$low))) {
			s = ($encodeRune((((x.$low + ((x.$high >> 31) * 4294967296)) >> 0))));
		}
		_r = makeString(new flag(v.flag).ro(), s, t); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		$24r = _r;
		$s = 2; case 2: return $24r;
		/* */ } return; } var $f = {$blk: cvtIntString, $c: true, $r, $24r, _r, s, t, v, x, x$1, $s};return $f;
	};
	cvtUintString = function(v, t) {
		var {$24r, _r, s, t, v, x, x$1, $s, $r, $c} = $restore(this, {v, t});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		s = "\xEF\xBF\xBD";
		x = $clone(v, Value).Uint();
		if ((x$1 = (new $Uint64(0, ((x.$low >> 0)))), (x$1.$high === x.$high && x$1.$low === x.$low))) {
			s = ($encodeRune(((x.$low >> 0))));
		}
		_r = makeString(new flag(v.flag).ro(), s, t); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		$24r = _r;
		$s = 2; case 2: return $24r;
		/* */ } return; } var $f = {$blk: cvtUintString, $c: true, $r, $24r, _r, s, t, v, x, x$1, $s};return $f;
	};
	cvtBytesString = function(v, t) {
		var {$24r, _arg, _arg$1, _arg$2, _r, _r$1, t, v, $s, $r, $c} = $restore(this, {v, t});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		_arg = new flag(v.flag).ro();
		_r = $clone(v, Value).Bytes(); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		_arg$1 = ($bytesToString(_r));
		_arg$2 = t;
		_r$1 = makeString(_arg, _arg$1, _arg$2); /* */ $s = 2; case 2: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
		$24r = _r$1;
		$s = 3; case 3: return $24r;
		/* */ } return; } var $f = {$blk: cvtBytesString, $c: true, $r, $24r, _arg, _arg$1, _arg$2, _r, _r$1, t, v, $s};return $f;
	};
	cvtStringBytes = function(v, t) {
		var {$24r, _arg, _arg$1, _arg$2, _r, _r$1, t, v, $s, $r, $c} = $restore(this, {v, t});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		_arg = new flag(v.flag).ro();
		_r = $clone(v, Value).String(); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		_arg$1 = (new sliceType$4($stringToBytes(_r)));
		_arg$2 = t;
		_r$1 = makeBytes(_arg, _arg$1, _arg$2); /* */ $s = 2; case 2: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
		$24r = _r$1;
		$s = 3; case 3: return $24r;
		/* */ } return; } var $f = {$blk: cvtStringBytes, $c: true, $r, $24r, _arg, _arg$1, _arg$2, _r, _r$1, t, v, $s};return $f;
	};
	cvtRunesString = function(v, t) {
		var {$24r, _arg, _arg$1, _arg$2, _r, _r$1, t, v, $s, $r, $c} = $restore(this, {v, t});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		_arg = new flag(v.flag).ro();
		_r = $clone(v, Value).runes(); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		_arg$1 = ($runesToString(_r));
		_arg$2 = t;
		_r$1 = makeString(_arg, _arg$1, _arg$2); /* */ $s = 2; case 2: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
		$24r = _r$1;
		$s = 3; case 3: return $24r;
		/* */ } return; } var $f = {$blk: cvtRunesString, $c: true, $r, $24r, _arg, _arg$1, _arg$2, _r, _r$1, t, v, $s};return $f;
	};
	cvtStringRunes = function(v, t) {
		var {$24r, _arg, _arg$1, _arg$2, _r, _r$1, t, v, $s, $r, $c} = $restore(this, {v, t});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		_arg = new flag(v.flag).ro();
		_r = $clone(v, Value).String(); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		_arg$1 = (new sliceType$10($stringToRunes(_r)));
		_arg$2 = t;
		_r$1 = makeRunes(_arg, _arg$1, _arg$2); /* */ $s = 2; case 2: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
		$24r = _r$1;
		$s = 3; case 3: return $24r;
		/* */ } return; } var $f = {$blk: cvtStringRunes, $c: true, $r, $24r, _arg, _arg$1, _arg$2, _r, _r$1, t, v, $s};return $f;
	};
	cvtT2I = function(v, typ) {
		var {$24r, _r, _r$1, _r$2, _r$3, _r$4, target, typ, v, x, $s, $r, $c} = $restore(this, {v, typ});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		_r = typ.common(); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		_r$1 = unsafe_New(_r); /* */ $s = 2; case 2: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
		target = _r$1;
		_r$2 = valueInterface($clone(v, Value), false); /* */ $s = 3; case 3: if($c) { $c = false; _r$2 = _r$2.$blk(); } if (_r$2 && _r$2.$blk !== undefined) { break s; }
		x = _r$2;
		_r$3 = typ.NumMethod(); /* */ $s = 7; case 7: if($c) { $c = false; _r$3 = _r$3.$blk(); } if (_r$3 && _r$3.$blk !== undefined) { break s; }
		/* */ if (_r$3 === 0) { $s = 4; continue; }
		/* */ $s = 5; continue;
		/* if (_r$3 === 0) { */ case 4:
			(target).$set(x);
			$s = 6; continue;
		/* } else { */ case 5:
			ifaceE2I($assertType(typ, ptrType$1), x, target);
		/* } */ case 6:
		_r$4 = typ.common(); /* */ $s = 8; case 8: if($c) { $c = false; _r$4 = _r$4.$blk(); } if (_r$4 && _r$4.$blk !== undefined) { break s; }
		$24r = new Value.ptr(_r$4, target, (((new flag(v.flag).ro() | 128) >>> 0) | 20) >>> 0);
		$s = 9; case 9: return $24r;
		/* */ } return; } var $f = {$blk: cvtT2I, $c: true, $r, $24r, _r, _r$1, _r$2, _r$3, _r$4, target, typ, v, x, $s};return $f;
	};
	cvtI2I = function(v, typ) {
		var {$24r, _r, _r$1, _r$2, ret, typ, v, $s, $r, $c} = $restore(this, {v, typ});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		/* */ if ($clone(v, Value).IsNil()) { $s = 1; continue; }
		/* */ $s = 2; continue;
		/* if ($clone(v, Value).IsNil()) { */ case 1:
			_r = Zero(typ); /* */ $s = 3; case 3: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
			ret = _r;
			ret.flag = (ret.flag | (new flag(v.flag).ro())) >>> 0;
			$s = -1; return ret;
		/* } */ case 2:
		_r$1 = $clone(v, Value).Elem(); /* */ $s = 4; case 4: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
		_r$2 = cvtT2I($clone(_r$1, Value), typ); /* */ $s = 5; case 5: if($c) { $c = false; _r$2 = _r$2.$blk(); } if (_r$2 && _r$2.$blk !== undefined) { break s; }
		$24r = _r$2;
		$s = 6; case 6: return $24r;
		/* */ } return; } var $f = {$blk: cvtI2I, $c: true, $r, $24r, _r, _r$1, _r$2, ret, typ, v, $s};return $f;
	};
	structField.ptr.prototype.embedded = function() {
		var f;
		f = this;
		return $clone(f.name, name).embedded();
	};
	structField.prototype.embedded = function() { return this.$val.embedded(); };
	Method.ptr.prototype.IsExported = function() {
		var m;
		m = this;
		return m.PkgPath === "";
	};
	Method.prototype.IsExported = function() { return this.$val.IsExported(); };
	Kind.prototype.String = function() {
		var k, x;
		k = this.$val;
		if (((k >>> 0)) < ((kindNames.$length >>> 0))) {
			return (x = ((k >>> 0)), ((x < 0 || x >= kindNames.$length) ? ($throwRuntimeError("index out of range"), undefined) : kindNames.$array[kindNames.$offset + x]));
		}
		return "kind" + strconv.Itoa(((k >> 0)));
	};
	$ptrType(Kind).prototype.String = function() { return new Kind(this.$get()).String(); };
	rtype.ptr.prototype.String = function() {
		var s, t;
		t = this;
		s = $clone(t.nameOff(t.str), name).name();
		if (!((((t.tflag & 2) >>> 0) === 0))) {
			return $substring(s, 1);
		}
		return s;
	};
	rtype.prototype.String = function() { return this.$val.String(); };
	rtype.ptr.prototype.Size = function() {
		var t;
		t = this;
		return t.size;
	};
	rtype.prototype.Size = function() { return this.$val.Size(); };
	rtype.ptr.prototype.Bits = function() {
		var k, t;
		t = this;
		if (t === ptrType$1.nil) {
			$panic(new $String("reflect: Bits of nil Type"));
		}
		k = t.Kind();
		if (k < 2 || k > 16) {
			$panic(new $String("reflect: Bits of non-arithmetic Type " + t.String()));
		}
		return $imul(((t.size >> 0)), 8);
	};
	rtype.prototype.Bits = function() { return this.$val.Bits(); };
	rtype.ptr.prototype.Align = function() {
		var t;
		t = this;
		return ((t.align >> 0));
	};
	rtype.prototype.Align = function() { return this.$val.Align(); };
	rtype.ptr.prototype.FieldAlign = function() {
		var t;
		t = this;
		return ((t.fieldAlign >> 0));
	};
	rtype.prototype.FieldAlign = function() { return this.$val.FieldAlign(); };
	rtype.ptr.prototype.Kind = function() {
		var t;
		t = this;
		return ((((t.kind & 31) >>> 0) >>> 0));
	};
	rtype.prototype.Kind = function() { return this.$val.Kind(); };
	rtype.ptr.prototype.common = function() {
		var t;
		t = this;
		return t;
	};
	rtype.prototype.common = function() { return this.$val.common(); };
	rtype.ptr.prototype.exportedMethods = function() {
		var t, ut;
		t = this;
		ut = t.uncommon();
		if (ut === ptrType$10.nil) {
			return sliceType$11.nil;
		}
		return ut.exportedMethods();
	};
	rtype.prototype.exportedMethods = function() { return this.$val.exportedMethods(); };
	rtype.ptr.prototype.NumMethod = function() {
		var t, tt;
		t = this;
		if (t.Kind() === 20) {
			tt = (t.kindType);
			return tt.NumMethod();
		}
		return t.exportedMethods().$length;
	};
	rtype.prototype.NumMethod = function() { return this.$val.NumMethod(); };
	rtype.ptr.prototype.MethodByName = function(name$1) {
		var {$24r, _i, _r, _ref, _tmp, _tmp$1, _tmp$2, _tmp$3, _tmp$4, _tmp$5, _tuple, i, m, name$1, ok, p, t, tt, ut, $s, $r, $c} = $restore(this, {name$1});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		m = new Method.ptr("", "", $ifaceNil, new Value.ptr(ptrType$1.nil, 0, 0), 0);
		ok = false;
		t = this;
		if (t.Kind() === 20) {
			tt = (t.kindType);
			_tuple = tt.MethodByName(name$1);
			Method.copy(m, _tuple[0]);
			ok = _tuple[1];
			$s = -1; return [m, ok];
		}
		ut = t.uncommon();
		if (ut === ptrType$10.nil) {
			_tmp = new Method.ptr("", "", $ifaceNil, new Value.ptr(ptrType$1.nil, 0, 0), 0);
			_tmp$1 = false;
			Method.copy(m, _tmp);
			ok = _tmp$1;
			$s = -1; return [m, ok];
		}
		_ref = ut.exportedMethods();
		_i = 0;
		/* while (true) { */ case 1:
			/* if (!(_i < _ref.$length)) { break; } */ if(!(_i < _ref.$length)) { $s = 2; continue; }
			i = _i;
			p = $clone(((_i < 0 || _i >= _ref.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref.$array[_ref.$offset + _i]), method);
			/* */ if ($clone(t.nameOff(p.name), name).name() === name$1) { $s = 3; continue; }
			/* */ $s = 4; continue;
			/* if ($clone(t.nameOff(p.name), name).name() === name$1) { */ case 3:
				_r = t.Method(i); /* */ $s = 5; case 5: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
				_tmp$2 = $clone(_r, Method);
				_tmp$3 = true;
				Method.copy(m, _tmp$2);
				ok = _tmp$3;
				$24r = [m, ok];
				$s = 6; case 6: return $24r;
			/* } */ case 4:
			_i++;
		$s = 1; continue;
		case 2:
		_tmp$4 = new Method.ptr("", "", $ifaceNil, new Value.ptr(ptrType$1.nil, 0, 0), 0);
		_tmp$5 = false;
		Method.copy(m, _tmp$4);
		ok = _tmp$5;
		$s = -1; return [m, ok];
		/* */ } return; } var $f = {$blk: rtype.ptr.prototype.MethodByName, $c: true, $r, $24r, _i, _r, _ref, _tmp, _tmp$1, _tmp$2, _tmp$3, _tmp$4, _tmp$5, _tuple, i, m, name$1, ok, p, t, tt, ut, $s};return $f;
	};
	rtype.prototype.MethodByName = function(name$1) { return this.$val.MethodByName(name$1); };
	rtype.ptr.prototype.PkgPath = function() {
		var t, ut;
		t = this;
		if (((t.tflag & 4) >>> 0) === 0) {
			return "";
		}
		ut = t.uncommon();
		if (ut === ptrType$10.nil) {
			return "";
		}
		return $clone(t.nameOff(ut.pkgPath), name).name();
	};
	rtype.prototype.PkgPath = function() { return this.$val.PkgPath(); };
	rtype.ptr.prototype.hasName = function() {
		var t;
		t = this;
		return !((((t.tflag & 4) >>> 0) === 0));
	};
	rtype.prototype.hasName = function() { return this.$val.hasName(); };
	rtype.ptr.prototype.Name = function() {
		var _1, i, s, sqBrackets, t;
		t = this;
		if (!t.hasName()) {
			return "";
		}
		s = t.String();
		i = s.length - 1 >> 0;
		sqBrackets = 0;
		while (true) {
			if (!(i >= 0 && (!((s.charCodeAt(i) === 46)) || !((sqBrackets === 0))))) { break; }
			_1 = s.charCodeAt(i);
			if (_1 === (93)) {
				sqBrackets = sqBrackets + (1) >> 0;
			} else if (_1 === (91)) {
				sqBrackets = sqBrackets - (1) >> 0;
			}
			i = i - (1) >> 0;
		}
		return $substring(s, (i + 1 >> 0));
	};
	rtype.prototype.Name = function() { return this.$val.Name(); };
	rtype.ptr.prototype.ChanDir = function() {
		var t, tt;
		t = this;
		if (!((t.Kind() === 18))) {
			$panic(new $String("reflect: ChanDir of non-chan type " + t.String()));
		}
		tt = (t.kindType);
		return ((tt.dir >> 0));
	};
	rtype.prototype.ChanDir = function() { return this.$val.ChanDir(); };
	rtype.ptr.prototype.IsVariadic = function() {
		var t, tt;
		t = this;
		if (!((t.Kind() === 19))) {
			$panic(new $String("reflect: IsVariadic of non-func type " + t.String()));
		}
		tt = (t.kindType);
		return !((((tt.outCount & 32768) >>> 0) === 0));
	};
	rtype.prototype.IsVariadic = function() { return this.$val.IsVariadic(); };
	rtype.ptr.prototype.Elem = function() {
		var _1, t, tt, tt$1, tt$2, tt$3, tt$4;
		t = this;
		_1 = t.Kind();
		if (_1 === (17)) {
			tt = (t.kindType);
			return toType(tt.elem);
		} else if (_1 === (18)) {
			tt$1 = (t.kindType);
			return toType(tt$1.elem);
		} else if (_1 === (21)) {
			tt$2 = (t.kindType);
			return toType(tt$2.elem);
		} else if (_1 === (22)) {
			tt$3 = (t.kindType);
			return toType(tt$3.elem);
		} else if (_1 === (23)) {
			tt$4 = (t.kindType);
			return toType(tt$4.elem);
		}
		$panic(new $String("reflect: Elem of invalid type " + t.String()));
	};
	rtype.prototype.Elem = function() { return this.$val.Elem(); };
	rtype.ptr.prototype.Field = function(i) {
		var i, t, tt;
		t = this;
		if (!((t.Kind() === 25))) {
			$panic(new $String("reflect: Field of non-struct type " + t.String()));
		}
		tt = (t.kindType);
		return tt.Field(i);
	};
	rtype.prototype.Field = function(i) { return this.$val.Field(i); };
	rtype.ptr.prototype.FieldByIndex = function(index) {
		var {$24r, _r, index, t, tt, $s, $r, $c} = $restore(this, {index});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		t = this;
		if (!((t.Kind() === 25))) {
			$panic(new $String("reflect: FieldByIndex of non-struct type " + t.String()));
		}
		tt = (t.kindType);
		_r = tt.FieldByIndex(index); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		$24r = _r;
		$s = 2; case 2: return $24r;
		/* */ } return; } var $f = {$blk: rtype.ptr.prototype.FieldByIndex, $c: true, $r, $24r, _r, index, t, tt, $s};return $f;
	};
	rtype.prototype.FieldByIndex = function(index) { return this.$val.FieldByIndex(index); };
	rtype.ptr.prototype.FieldByName = function(name$1) {
		var {$24r, _r, name$1, t, tt, $s, $r, $c} = $restore(this, {name$1});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		t = this;
		if (!((t.Kind() === 25))) {
			$panic(new $String("reflect: FieldByName of non-struct type " + t.String()));
		}
		tt = (t.kindType);
		_r = tt.FieldByName(name$1); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		$24r = _r;
		$s = 2; case 2: return $24r;
		/* */ } return; } var $f = {$blk: rtype.ptr.prototype.FieldByName, $c: true, $r, $24r, _r, name$1, t, tt, $s};return $f;
	};
	rtype.prototype.FieldByName = function(name$1) { return this.$val.FieldByName(name$1); };
	rtype.ptr.prototype.FieldByNameFunc = function(match) {
		var {$24r, _r, match, t, tt, $s, $r, $c} = $restore(this, {match});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		t = this;
		if (!((t.Kind() === 25))) {
			$panic(new $String("reflect: FieldByNameFunc of non-struct type " + t.String()));
		}
		tt = (t.kindType);
		_r = tt.FieldByNameFunc(match); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		$24r = _r;
		$s = 2; case 2: return $24r;
		/* */ } return; } var $f = {$blk: rtype.ptr.prototype.FieldByNameFunc, $c: true, $r, $24r, _r, match, t, tt, $s};return $f;
	};
	rtype.prototype.FieldByNameFunc = function(match) { return this.$val.FieldByNameFunc(match); };
	rtype.ptr.prototype.In = function(i) {
		var i, t, tt, x;
		t = this;
		if (!((t.Kind() === 19))) {
			$panic(new $String("reflect: In of non-func type " + t.String()));
		}
		tt = (t.kindType);
		return toType((x = tt.in$(), ((i < 0 || i >= x.$length) ? ($throwRuntimeError("index out of range"), undefined) : x.$array[x.$offset + i])));
	};
	rtype.prototype.In = function(i) { return this.$val.In(i); };
	rtype.ptr.prototype.Key = function() {
		var t, tt;
		t = this;
		if (!((t.Kind() === 21))) {
			$panic(new $String("reflect: Key of non-map type " + t.String()));
		}
		tt = (t.kindType);
		return toType(tt.key);
	};
	rtype.prototype.Key = function() { return this.$val.Key(); };
	rtype.ptr.prototype.Len = function() {
		var t, tt;
		t = this;
		if (!((t.Kind() === 17))) {
			$panic(new $String("reflect: Len of non-array type " + t.String()));
		}
		tt = (t.kindType);
		return ((tt.len >> 0));
	};
	rtype.prototype.Len = function() { return this.$val.Len(); };
	rtype.ptr.prototype.NumField = function() {
		var t, tt;
		t = this;
		if (!((t.Kind() === 25))) {
			$panic(new $String("reflect: NumField of non-struct type " + t.String()));
		}
		tt = (t.kindType);
		return tt.fields.$length;
	};
	rtype.prototype.NumField = function() { return this.$val.NumField(); };
	rtype.ptr.prototype.NumIn = function() {
		var t, tt;
		t = this;
		if (!((t.Kind() === 19))) {
			$panic(new $String("reflect: NumIn of non-func type " + t.String()));
		}
		tt = (t.kindType);
		return ((tt.inCount >> 0));
	};
	rtype.prototype.NumIn = function() { return this.$val.NumIn(); };
	rtype.ptr.prototype.NumOut = function() {
		var t, tt;
		t = this;
		if (!((t.Kind() === 19))) {
			$panic(new $String("reflect: NumOut of non-func type " + t.String()));
		}
		tt = (t.kindType);
		return tt.out().$length;
	};
	rtype.prototype.NumOut = function() { return this.$val.NumOut(); };
	rtype.ptr.prototype.Out = function(i) {
		var i, t, tt, x;
		t = this;
		if (!((t.Kind() === 19))) {
			$panic(new $String("reflect: Out of non-func type " + t.String()));
		}
		tt = (t.kindType);
		return toType((x = tt.out(), ((i < 0 || i >= x.$length) ? ($throwRuntimeError("index out of range"), undefined) : x.$array[x.$offset + i])));
	};
	rtype.prototype.Out = function(i) { return this.$val.Out(i); };
	ChanDir.prototype.String = function() {
		var _1, d;
		d = this.$val;
		_1 = d;
		if (_1 === (2)) {
			return "chan<-";
		} else if (_1 === (1)) {
			return "<-chan";
		} else if (_1 === (3)) {
			return "chan";
		}
		return "ChanDir" + strconv.Itoa(((d >> 0)));
	};
	$ptrType(ChanDir).prototype.String = function() { return new ChanDir(this.$get()).String(); };
	interfaceType.ptr.prototype.Method = function(i) {
		var i, m, p, pname, t, x;
		m = new Method.ptr("", "", $ifaceNil, new Value.ptr(ptrType$1.nil, 0, 0), 0);
		t = this;
		if (i < 0 || i >= t.methods.$length) {
			return m;
		}
		p = (x = t.methods, ((i < 0 || i >= x.$length) ? ($throwRuntimeError("index out of range"), undefined) : x.$array[x.$offset + i]));
		pname = $clone(t.rtype.nameOff(p.name), name);
		m.Name = $clone(pname, name).name();
		if (!$clone(pname, name).isExported()) {
			m.PkgPath = $clone(pname, name).pkgPath();
			if (m.PkgPath === "") {
				m.PkgPath = $clone(t.pkgPath, name).name();
			}
		}
		m.Type = toType(t.rtype.typeOff(p.typ));
		m.Index = i;
		return m;
	};
	interfaceType.prototype.Method = function(i) { return this.$val.Method(i); };
	interfaceType.ptr.prototype.NumMethod = function() {
		var t;
		t = this;
		return t.methods.$length;
	};
	interfaceType.prototype.NumMethod = function() { return this.$val.NumMethod(); };
	interfaceType.ptr.prototype.MethodByName = function(name$1) {
		var _i, _ref, _tmp, _tmp$1, i, m, name$1, ok, p, t, x;
		m = new Method.ptr("", "", $ifaceNil, new Value.ptr(ptrType$1.nil, 0, 0), 0);
		ok = false;
		t = this;
		if (t === ptrType$11.nil) {
			return [m, ok];
		}
		p = ptrType$12.nil;
		_ref = t.methods;
		_i = 0;
		while (true) {
			if (!(_i < _ref.$length)) { break; }
			i = _i;
			p = (x = t.methods, ((i < 0 || i >= x.$length) ? ($throwRuntimeError("index out of range"), undefined) : x.$array[x.$offset + i]));
			if ($clone(t.rtype.nameOff(p.name), name).name() === name$1) {
				_tmp = $clone(t.Method(i), Method);
				_tmp$1 = true;
				Method.copy(m, _tmp);
				ok = _tmp$1;
				return [m, ok];
			}
			_i++;
		}
		return [m, ok];
	};
	interfaceType.prototype.MethodByName = function(name$1) { return this.$val.MethodByName(name$1); };
	StructField.ptr.prototype.IsExported = function() {
		var f;
		f = this;
		return f.PkgPath === "";
	};
	StructField.prototype.IsExported = function() { return this.$val.IsExported(); };
	StructTag.prototype.Get = function(key) {
		var _tuple, key, tag, v;
		tag = this.$val;
		_tuple = new StructTag(tag).Lookup(key);
		v = _tuple[0];
		return v;
	};
	$ptrType(StructTag).prototype.Get = function(key) { return new StructTag(this.$get()).Get(key); };
	StructTag.prototype.Lookup = function(key) {
		var _tmp, _tmp$1, _tmp$2, _tmp$3, _tuple, err, i, key, name$1, ok, qvalue, tag, value, value$1;
		value = "";
		ok = false;
		tag = this.$val;
		while (true) {
			if (!(!(tag === ""))) { break; }
			i = 0;
			while (true) {
				if (!(i < tag.length && (tag.charCodeAt(i) === 32))) { break; }
				i = i + (1) >> 0;
			}
			tag = $substring(tag, i);
			if (tag === "") {
				break;
			}
			i = 0;
			while (true) {
				if (!(i < tag.length && tag.charCodeAt(i) > 32 && !((tag.charCodeAt(i) === 58)) && !((tag.charCodeAt(i) === 34)) && !((tag.charCodeAt(i) === 127)))) { break; }
				i = i + (1) >> 0;
			}
			if ((i === 0) || (i + 1 >> 0) >= tag.length || !((tag.charCodeAt(i) === 58)) || !((tag.charCodeAt((i + 1 >> 0)) === 34))) {
				break;
			}
			name$1 = ($substring(tag, 0, i));
			tag = $substring(tag, (i + 1 >> 0));
			i = 1;
			while (true) {
				if (!(i < tag.length && !((tag.charCodeAt(i) === 34)))) { break; }
				if (tag.charCodeAt(i) === 92) {
					i = i + (1) >> 0;
				}
				i = i + (1) >> 0;
			}
			if (i >= tag.length) {
				break;
			}
			qvalue = ($substring(tag, 0, (i + 1 >> 0)));
			tag = $substring(tag, (i + 1 >> 0));
			if (key === name$1) {
				_tuple = strconv.Unquote(qvalue);
				value$1 = _tuple[0];
				err = _tuple[1];
				if (!($interfaceIsEqual(err, $ifaceNil))) {
					break;
				}
				_tmp = value$1;
				_tmp$1 = true;
				value = _tmp;
				ok = _tmp$1;
				return [value, ok];
			}
		}
		_tmp$2 = "";
		_tmp$3 = false;
		value = _tmp$2;
		ok = _tmp$3;
		return [value, ok];
	};
	$ptrType(StructTag).prototype.Lookup = function(key) { return new StructTag(this.$get()).Lookup(key); };
	structType.ptr.prototype.Field = function(i) {
		var f, i, p, t, tag, x;
		f = new StructField.ptr("", "", $ifaceNil, "", 0, sliceType$7.nil, false);
		t = this;
		if (i < 0 || i >= t.fields.$length) {
			$panic(new $String("reflect: Field index out of bounds"));
		}
		p = (x = t.fields, ((i < 0 || i >= x.$length) ? ($throwRuntimeError("index out of range"), undefined) : x.$array[x.$offset + i]));
		f.Type = toType(p.typ);
		f.Name = $clone(p.name, name).name();
		f.Anonymous = p.embedded();
		if (!$clone(p.name, name).isExported()) {
			f.PkgPath = $clone(t.pkgPath, name).name();
		}
		tag = $clone(p.name, name).tag();
		if (!(tag === "")) {
			f.Tag = (tag);
		}
		f.Offset = p.offset;
		f.Index = new sliceType$7([i]);
		return f;
	};
	structType.prototype.Field = function(i) { return this.$val.Field(i); };
	structType.ptr.prototype.FieldByIndex = function(index) {
		var {_i, _r, _r$1, _r$2, _r$3, _r$4, _ref, _v, f, ft, i, index, t, x, $s, $r, $c} = $restore(this, {index});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		f = new StructField.ptr("", "", $ifaceNil, "", 0, sliceType$7.nil, false);
		t = this;
		f.Type = toType(t.rtype);
		_ref = index;
		_i = 0;
		/* while (true) { */ case 1:
			/* if (!(_i < _ref.$length)) { break; } */ if(!(_i < _ref.$length)) { $s = 2; continue; }
			i = _i;
			x = ((_i < 0 || _i >= _ref.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref.$array[_ref.$offset + _i]);
			/* */ if (i > 0) { $s = 3; continue; }
			/* */ $s = 4; continue;
			/* if (i > 0) { */ case 3:
				ft = f.Type;
				_r = ft.Kind(); /* */ $s = 8; case 8: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
				if (!(_r === 22)) { _v = false; $s = 7; continue s; }
				_r$1 = ft.Elem(); /* */ $s = 9; case 9: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
				_r$2 = _r$1.Kind(); /* */ $s = 10; case 10: if($c) { $c = false; _r$2 = _r$2.$blk(); } if (_r$2 && _r$2.$blk !== undefined) { break s; }
				_v = _r$2 === 25; case 7:
				/* */ if (_v) { $s = 5; continue; }
				/* */ $s = 6; continue;
				/* if (_v) { */ case 5:
					_r$3 = ft.Elem(); /* */ $s = 11; case 11: if($c) { $c = false; _r$3 = _r$3.$blk(); } if (_r$3 && _r$3.$blk !== undefined) { break s; }
					ft = _r$3;
				/* } */ case 6:
				f.Type = ft;
			/* } */ case 4:
			_r$4 = f.Type.Field(x); /* */ $s = 12; case 12: if($c) { $c = false; _r$4 = _r$4.$blk(); } if (_r$4 && _r$4.$blk !== undefined) { break s; }
			StructField.copy(f, _r$4);
			_i++;
		$s = 1; continue;
		case 2:
		$s = -1; return f;
		/* */ } return; } var $f = {$blk: structType.ptr.prototype.FieldByIndex, $c: true, $r, _i, _r, _r$1, _r$2, _r$3, _r$4, _ref, _v, f, ft, i, index, t, x, $s};return $f;
	};
	structType.prototype.FieldByIndex = function(index) { return this.$val.FieldByIndex(index); };
	structType.ptr.prototype.FieldByNameFunc = function(match) {
		var {_entry, _entry$1, _entry$2, _entry$3, _i, _i$1, _key, _key$1, _key$2, _key$3, _r, _r$1, _ref, _ref$1, _tmp, _tmp$1, _tmp$2, _tmp$3, count, current, f, fname, i, index, match, next, nextCount, ntyp, ok, result, scan, styp, t, t$1, visited, x, $s, $r, $c} = $restore(this, {match});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		result = new StructField.ptr("", "", $ifaceNil, "", 0, sliceType$7.nil, false);
		ok = false;
		t = this;
		current = new sliceType$12([]);
		next = new sliceType$12([$clone(new fieldScan.ptr(t, sliceType$7.nil), fieldScan)]);
		nextCount = false;
		visited = $makeMap(ptrType$13.keyFor, []);
		/* while (true) { */ case 1:
			/* if (!(next.$length > 0)) { break; } */ if(!(next.$length > 0)) { $s = 2; continue; }
			_tmp = next;
			_tmp$1 = $subslice(current, 0, 0);
			current = _tmp;
			next = _tmp$1;
			count = nextCount;
			nextCount = false;
			_ref = current;
			_i = 0;
			/* while (true) { */ case 3:
				/* if (!(_i < _ref.$length)) { break; } */ if(!(_i < _ref.$length)) { $s = 4; continue; }
				scan = $clone(((_i < 0 || _i >= _ref.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref.$array[_ref.$offset + _i]), fieldScan);
				t$1 = scan.typ;
				if ((_entry = $mapIndex(visited,ptrType$13.keyFor(t$1)), _entry !== undefined ? _entry.v : false)) {
					_i++;
					/* continue; */ $s = 3; continue;
				}
				_key = t$1; (visited || $throwRuntimeError("assignment to entry in nil map")).set(ptrType$13.keyFor(_key), { k: _key, v: true });
				_ref$1 = t$1.fields;
				_i$1 = 0;
				/* while (true) { */ case 5:
					/* if (!(_i$1 < _ref$1.$length)) { break; } */ if(!(_i$1 < _ref$1.$length)) { $s = 6; continue; }
					i = _i$1;
					f = (x = t$1.fields, ((i < 0 || i >= x.$length) ? ($throwRuntimeError("index out of range"), undefined) : x.$array[x.$offset + i]));
					fname = $clone(f.name, name).name();
					ntyp = ptrType$1.nil;
					/* */ if (f.embedded()) { $s = 7; continue; }
					/* */ $s = 8; continue;
					/* if (f.embedded()) { */ case 7:
						ntyp = f.typ;
						/* */ if (ntyp.Kind() === 22) { $s = 9; continue; }
						/* */ $s = 10; continue;
						/* if (ntyp.Kind() === 22) { */ case 9:
							_r = ntyp.Elem().common(); /* */ $s = 11; case 11: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
							ntyp = _r;
						/* } */ case 10:
					/* } */ case 8:
					_r$1 = match(fname); /* */ $s = 14; case 14: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
					/* */ if (_r$1) { $s = 12; continue; }
					/* */ $s = 13; continue;
					/* if (_r$1) { */ case 12:
						if ((_entry$1 = $mapIndex(count,ptrType$13.keyFor(t$1)), _entry$1 !== undefined ? _entry$1.v : 0) > 1 || ok) {
							_tmp$2 = new StructField.ptr("", "", $ifaceNil, "", 0, sliceType$7.nil, false);
							_tmp$3 = false;
							StructField.copy(result, _tmp$2);
							ok = _tmp$3;
							$s = -1; return [result, ok];
						}
						StructField.copy(result, t$1.Field(i));
						result.Index = sliceType$7.nil;
						result.Index = $appendSlice(result.Index, scan.index);
						result.Index = $append(result.Index, i);
						ok = true;
						_i$1++;
						/* continue; */ $s = 5; continue;
					/* } */ case 13:
					if (ok || ntyp === ptrType$1.nil || !((ntyp.Kind() === 25))) {
						_i$1++;
						/* continue; */ $s = 5; continue;
					}
					styp = (ntyp.kindType);
					if ((_entry$2 = $mapIndex(nextCount,ptrType$13.keyFor(styp)), _entry$2 !== undefined ? _entry$2.v : 0) > 0) {
						_key$1 = styp; (nextCount || $throwRuntimeError("assignment to entry in nil map")).set(ptrType$13.keyFor(_key$1), { k: _key$1, v: 2 });
						_i$1++;
						/* continue; */ $s = 5; continue;
					}
					if (nextCount === false) {
						nextCount = $makeMap(ptrType$13.keyFor, []);
					}
					_key$2 = styp; (nextCount || $throwRuntimeError("assignment to entry in nil map")).set(ptrType$13.keyFor(_key$2), { k: _key$2, v: 1 });
					if ((_entry$3 = $mapIndex(count,ptrType$13.keyFor(t$1)), _entry$3 !== undefined ? _entry$3.v : 0) > 1) {
						_key$3 = styp; (nextCount || $throwRuntimeError("assignment to entry in nil map")).set(ptrType$13.keyFor(_key$3), { k: _key$3, v: 2 });
					}
					index = sliceType$7.nil;
					index = $appendSlice(index, scan.index);
					index = $append(index, i);
					next = $append(next, new fieldScan.ptr(styp, index));
					_i$1++;
				$s = 5; continue;
				case 6:
				_i++;
			$s = 3; continue;
			case 4:
			if (ok) {
				/* break; */ $s = 2; continue;
			}
		$s = 1; continue;
		case 2:
		$s = -1; return [result, ok];
		/* */ } return; } var $f = {$blk: structType.ptr.prototype.FieldByNameFunc, $c: true, $r, _entry, _entry$1, _entry$2, _entry$3, _i, _i$1, _key, _key$1, _key$2, _key$3, _r, _r$1, _ref, _ref$1, _tmp, _tmp$1, _tmp$2, _tmp$3, count, current, f, fname, i, index, match, next, nextCount, ntyp, ok, result, scan, styp, t, t$1, visited, x, $s};return $f;
	};
	structType.prototype.FieldByNameFunc = function(match) { return this.$val.FieldByNameFunc(match); };
	structType.ptr.prototype.FieldByName = function(name$1) {
		var {$24r, _i, _r, _ref, _tmp, _tmp$1, _tuple, f, hasEmbeds, i, name$1, present, t, tf, x, $s, $r, $c} = $restore(this, {name$1});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		name$1 = [name$1];
		f = new StructField.ptr("", "", $ifaceNil, "", 0, sliceType$7.nil, false);
		present = false;
		t = this;
		hasEmbeds = false;
		if (!(name$1[0] === "")) {
			_ref = t.fields;
			_i = 0;
			while (true) {
				if (!(_i < _ref.$length)) { break; }
				i = _i;
				tf = (x = t.fields, ((i < 0 || i >= x.$length) ? ($throwRuntimeError("index out of range"), undefined) : x.$array[x.$offset + i]));
				if ($clone(tf.name, name).name() === name$1[0]) {
					_tmp = $clone(t.Field(i), StructField);
					_tmp$1 = true;
					StructField.copy(f, _tmp);
					present = _tmp$1;
					$s = -1; return [f, present];
				}
				if (tf.embedded()) {
					hasEmbeds = true;
				}
				_i++;
			}
		}
		if (!hasEmbeds) {
			$s = -1; return [f, present];
		}
		_r = t.FieldByNameFunc((function(name$1) { return function(s) {
			var s;
			return s === name$1[0];
		}; })(name$1)); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		_tuple = _r;
		StructField.copy(f, _tuple[0]);
		present = _tuple[1];
		$24r = [f, present];
		$s = 2; case 2: return $24r;
		/* */ } return; } var $f = {$blk: structType.ptr.prototype.FieldByName, $c: true, $r, $24r, _i, _r, _ref, _tmp, _tmp$1, _tuple, f, hasEmbeds, i, name$1, present, t, tf, x, $s};return $f;
	};
	structType.prototype.FieldByName = function(name$1) { return this.$val.FieldByName(name$1); };
	PtrTo = function(t) {
		var t;
		return PointerTo(t);
	};
	$pkg.PtrTo = PtrTo;
	PointerTo = function(t) {
		var t;
		return $assertType(t, ptrType$1).ptrTo();
	};
	$pkg.PointerTo = PointerTo;
	rtype.ptr.prototype.Implements = function(u) {
		var {_r, t, u, $s, $r, $c} = $restore(this, {u});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		t = this;
		if ($interfaceIsEqual(u, $ifaceNil)) {
			$panic(new $String("reflect: nil type passed to Type.Implements"));
		}
		_r = u.Kind(); /* */ $s = 3; case 3: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		/* */ if (!((_r === 20))) { $s = 1; continue; }
		/* */ $s = 2; continue;
		/* if (!((_r === 20))) { */ case 1:
			$panic(new $String("reflect: non-interface type passed to Type.Implements"));
		/* } */ case 2:
		$s = -1; return implements$1($assertType(u, ptrType$1), t);
		/* */ } return; } var $f = {$blk: rtype.ptr.prototype.Implements, $c: true, $r, _r, t, u, $s};return $f;
	};
	rtype.prototype.Implements = function(u) { return this.$val.Implements(u); };
	rtype.ptr.prototype.AssignableTo = function(u) {
		var {$24r, _r, t, u, uu, $s, $r, $c} = $restore(this, {u});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		t = this;
		if ($interfaceIsEqual(u, $ifaceNil)) {
			$panic(new $String("reflect: nil type passed to Type.AssignableTo"));
		}
		uu = $assertType(u, ptrType$1);
		_r = directlyAssignable(uu, t); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		$24r = _r || implements$1(uu, t);
		$s = 2; case 2: return $24r;
		/* */ } return; } var $f = {$blk: rtype.ptr.prototype.AssignableTo, $c: true, $r, $24r, _r, t, u, uu, $s};return $f;
	};
	rtype.prototype.AssignableTo = function(u) { return this.$val.AssignableTo(u); };
	rtype.ptr.prototype.ConvertibleTo = function(u) {
		var {$24r, _r, t, u, uu, $s, $r, $c} = $restore(this, {u});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		t = this;
		if ($interfaceIsEqual(u, $ifaceNil)) {
			$panic(new $String("reflect: nil type passed to Type.ConvertibleTo"));
		}
		uu = $assertType(u, ptrType$1);
		_r = convertOp(uu, t); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		$24r = !(_r === $throwNilPointerError);
		$s = 2; case 2: return $24r;
		/* */ } return; } var $f = {$blk: rtype.ptr.prototype.ConvertibleTo, $c: true, $r, $24r, _r, t, u, uu, $s};return $f;
	};
	rtype.prototype.ConvertibleTo = function(u) { return this.$val.ConvertibleTo(u); };
	implements$1 = function(T, V) {
		var T, V, i, i$1, j, j$1, t, tm, tm$1, tmName, tmName$1, tmPkgPath, tmPkgPath$1, v, v$1, vm, vm$1, vmName, vmName$1, vmPkgPath, vmPkgPath$1, vmethods, x, x$1, x$2;
		if (!((T.Kind() === 20))) {
			return false;
		}
		t = (T.kindType);
		if (t.methods.$length === 0) {
			return true;
		}
		if (V.Kind() === 20) {
			v = (V.kindType);
			i = 0;
			j = 0;
			while (true) {
				if (!(j < v.methods.$length)) { break; }
				tm = (x = t.methods, ((i < 0 || i >= x.$length) ? ($throwRuntimeError("index out of range"), undefined) : x.$array[x.$offset + i]));
				tmName = $clone(t.rtype.nameOff(tm.name), name);
				vm = (x$1 = v.methods, ((j < 0 || j >= x$1.$length) ? ($throwRuntimeError("index out of range"), undefined) : x$1.$array[x$1.$offset + j]));
				vmName = $clone(V.nameOff(vm.name), name);
				if ($clone(vmName, name).name() === $clone(tmName, name).name() && V.typeOff(vm.typ) === t.rtype.typeOff(tm.typ)) {
					if (!$clone(tmName, name).isExported()) {
						tmPkgPath = $clone(tmName, name).pkgPath();
						if (tmPkgPath === "") {
							tmPkgPath = $clone(t.pkgPath, name).name();
						}
						vmPkgPath = $clone(vmName, name).pkgPath();
						if (vmPkgPath === "") {
							vmPkgPath = $clone(v.pkgPath, name).name();
						}
						if (!(tmPkgPath === vmPkgPath)) {
							j = j + (1) >> 0;
							continue;
						}
					}
					i = i + (1) >> 0;
					if (i >= t.methods.$length) {
						return true;
					}
				}
				j = j + (1) >> 0;
			}
			return false;
		}
		v$1 = V.uncommon();
		if (v$1 === ptrType$10.nil) {
			return false;
		}
		i$1 = 0;
		vmethods = v$1.methods();
		j$1 = 0;
		while (true) {
			if (!(j$1 < ((v$1.mcount >> 0)))) { break; }
			tm$1 = (x$2 = t.methods, ((i$1 < 0 || i$1 >= x$2.$length) ? ($throwRuntimeError("index out of range"), undefined) : x$2.$array[x$2.$offset + i$1]));
			tmName$1 = $clone(t.rtype.nameOff(tm$1.name), name);
			vm$1 = $clone(((j$1 < 0 || j$1 >= vmethods.$length) ? ($throwRuntimeError("index out of range"), undefined) : vmethods.$array[vmethods.$offset + j$1]), method);
			vmName$1 = $clone(V.nameOff(vm$1.name), name);
			if ($clone(vmName$1, name).name() === $clone(tmName$1, name).name() && V.typeOff(vm$1.mtyp) === t.rtype.typeOff(tm$1.typ)) {
				if (!$clone(tmName$1, name).isExported()) {
					tmPkgPath$1 = $clone(tmName$1, name).pkgPath();
					if (tmPkgPath$1 === "") {
						tmPkgPath$1 = $clone(t.pkgPath, name).name();
					}
					vmPkgPath$1 = $clone(vmName$1, name).pkgPath();
					if (vmPkgPath$1 === "") {
						vmPkgPath$1 = $clone(V.nameOff(v$1.pkgPath), name).name();
					}
					if (!(tmPkgPath$1 === vmPkgPath$1)) {
						j$1 = j$1 + (1) >> 0;
						continue;
					}
				}
				i$1 = i$1 + (1) >> 0;
				if (i$1 >= t.methods.$length) {
					return true;
				}
			}
			j$1 = j$1 + (1) >> 0;
		}
		return false;
	};
	specialChannelAssignability = function(T, V) {
		var {$24r, T, V, _r, _v, $s, $r, $c} = $restore(this, {T, V});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		if (!((V.ChanDir() === 3) && (T.Name() === "" || V.Name() === ""))) { _v = false; $s = 1; continue s; }
		_r = haveIdenticalType(T.Elem(), V.Elem(), true); /* */ $s = 2; case 2: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		_v = _r; case 1:
		$24r = _v;
		$s = 3; case 3: return $24r;
		/* */ } return; } var $f = {$blk: specialChannelAssignability, $c: true, $r, $24r, T, V, _r, _v, $s};return $f;
	};
	directlyAssignable = function(T, V) {
		var {$24r, T, V, _r, _r$1, _v, $s, $r, $c} = $restore(this, {T, V});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		if (T === V) {
			$s = -1; return true;
		}
		if (T.hasName() && V.hasName() || !((T.Kind() === V.Kind()))) {
			$s = -1; return false;
		}
		if (!(T.Kind() === 18)) { _v = false; $s = 3; continue s; }
		_r = specialChannelAssignability(T, V); /* */ $s = 4; case 4: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		_v = _r; case 3:
		/* */ if (_v) { $s = 1; continue; }
		/* */ $s = 2; continue;
		/* if (_v) { */ case 1:
			$s = -1; return true;
		/* } */ case 2:
		_r$1 = haveIdenticalUnderlyingType(T, V, true); /* */ $s = 5; case 5: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
		$24r = _r$1;
		$s = 6; case 6: return $24r;
		/* */ } return; } var $f = {$blk: directlyAssignable, $c: true, $r, $24r, T, V, _r, _r$1, _v, $s};return $f;
	};
	haveIdenticalType = function(T, V, cmpTags) {
		var {$24r, T, V, _arg, _arg$1, _r, _r$1, _r$2, _r$3, _r$4, _r$5, _r$6, _r$7, _r$8, _v, _v$1, cmpTags, $s, $r, $c} = $restore(this, {T, V, cmpTags});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		if (cmpTags) {
			$s = -1; return $interfaceIsEqual(T, V);
		}
		_r = T.Name(); /* */ $s = 5; case 5: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		_r$1 = V.Name(); /* */ $s = 6; case 6: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
		if (!(_r === _r$1)) { _v$1 = true; $s = 4; continue s; }
		_r$2 = T.Kind(); /* */ $s = 7; case 7: if($c) { $c = false; _r$2 = _r$2.$blk(); } if (_r$2 && _r$2.$blk !== undefined) { break s; }
		_r$3 = V.Kind(); /* */ $s = 8; case 8: if($c) { $c = false; _r$3 = _r$3.$blk(); } if (_r$3 && _r$3.$blk !== undefined) { break s; }
		_v$1 = !((_r$2 === _r$3)); case 4:
		if (_v$1) { _v = true; $s = 3; continue s; }
		_r$4 = T.PkgPath(); /* */ $s = 9; case 9: if($c) { $c = false; _r$4 = _r$4.$blk(); } if (_r$4 && _r$4.$blk !== undefined) { break s; }
		_r$5 = V.PkgPath(); /* */ $s = 10; case 10: if($c) { $c = false; _r$5 = _r$5.$blk(); } if (_r$5 && _r$5.$blk !== undefined) { break s; }
		_v = !(_r$4 === _r$5); case 3:
		/* */ if (_v) { $s = 1; continue; }
		/* */ $s = 2; continue;
		/* if (_v) { */ case 1:
			$s = -1; return false;
		/* } */ case 2:
		_r$6 = T.common(); /* */ $s = 11; case 11: if($c) { $c = false; _r$6 = _r$6.$blk(); } if (_r$6 && _r$6.$blk !== undefined) { break s; }
		_arg = _r$6;
		_r$7 = V.common(); /* */ $s = 12; case 12: if($c) { $c = false; _r$7 = _r$7.$blk(); } if (_r$7 && _r$7.$blk !== undefined) { break s; }
		_arg$1 = _r$7;
		_r$8 = haveIdenticalUnderlyingType(_arg, _arg$1, false); /* */ $s = 13; case 13: if($c) { $c = false; _r$8 = _r$8.$blk(); } if (_r$8 && _r$8.$blk !== undefined) { break s; }
		$24r = _r$8;
		$s = 14; case 14: return $24r;
		/* */ } return; } var $f = {$blk: haveIdenticalType, $c: true, $r, $24r, T, V, _arg, _arg$1, _r, _r$1, _r$2, _r$3, _r$4, _r$5, _r$6, _r$7, _r$8, _v, _v$1, cmpTags, $s};return $f;
	};
	haveIdenticalUnderlyingType = function(T, V, cmpTags) {
		var {$24r, $24r$1, $24r$2, $24r$3, T, V, _1, _i, _r, _r$1, _r$2, _r$3, _r$4, _r$5, _r$6, _r$7, _ref, _v, _v$1, _v$2, cmpTags, i, i$1, i$2, kind, t, t$1, t$2, tf, v, v$1, v$2, vf, x, x$1, $s, $r, $c} = $restore(this, {T, V, cmpTags});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		if (T === V) {
			$s = -1; return true;
		}
		kind = T.Kind();
		if (!((kind === V.Kind()))) {
			$s = -1; return false;
		}
		if (1 <= kind && kind <= 16 || (kind === 24) || (kind === 26)) {
			$s = -1; return true;
		}
			_1 = kind;
			/* */ if (_1 === (17)) { $s = 2; continue; }
			/* */ if (_1 === (18)) { $s = 3; continue; }
			/* */ if (_1 === (19)) { $s = 4; continue; }
			/* */ if (_1 === (20)) { $s = 5; continue; }
			/* */ if (_1 === (21)) { $s = 6; continue; }
			/* */ if ((_1 === (22)) || (_1 === (23))) { $s = 7; continue; }
			/* */ if (_1 === (25)) { $s = 8; continue; }
			/* */ $s = 9; continue;
			/* if (_1 === (17)) { */ case 2:
				if (!(T.Len() === V.Len())) { _v = false; $s = 10; continue s; }
				_r = haveIdenticalType(T.Elem(), V.Elem(), cmpTags); /* */ $s = 11; case 11: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
				_v = _r; case 10:
				$24r = _v;
				$s = 12; case 12: return $24r;
			/* } else if (_1 === (18)) { */ case 3:
				if (!(V.ChanDir() === T.ChanDir())) { _v$1 = false; $s = 13; continue s; }
				_r$1 = haveIdenticalType(T.Elem(), V.Elem(), cmpTags); /* */ $s = 14; case 14: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
				_v$1 = _r$1; case 13:
				$24r$1 = _v$1;
				$s = 15; case 15: return $24r$1;
			/* } else if (_1 === (19)) { */ case 4:
				t = (T.kindType);
				v = (V.kindType);
				if (!((t.outCount === v.outCount)) || !((t.inCount === v.inCount))) {
					$s = -1; return false;
				}
				i = 0;
				/* while (true) { */ case 16:
					/* if (!(i < t.rtype.NumIn())) { break; } */ if(!(i < t.rtype.NumIn())) { $s = 17; continue; }
					_r$2 = haveIdenticalType(t.rtype.In(i), v.rtype.In(i), cmpTags); /* */ $s = 20; case 20: if($c) { $c = false; _r$2 = _r$2.$blk(); } if (_r$2 && _r$2.$blk !== undefined) { break s; }
					/* */ if (!_r$2) { $s = 18; continue; }
					/* */ $s = 19; continue;
					/* if (!_r$2) { */ case 18:
						$s = -1; return false;
					/* } */ case 19:
					i = i + (1) >> 0;
				$s = 16; continue;
				case 17:
				i$1 = 0;
				/* while (true) { */ case 21:
					/* if (!(i$1 < t.rtype.NumOut())) { break; } */ if(!(i$1 < t.rtype.NumOut())) { $s = 22; continue; }
					_r$3 = haveIdenticalType(t.rtype.Out(i$1), v.rtype.Out(i$1), cmpTags); /* */ $s = 25; case 25: if($c) { $c = false; _r$3 = _r$3.$blk(); } if (_r$3 && _r$3.$blk !== undefined) { break s; }
					/* */ if (!_r$3) { $s = 23; continue; }
					/* */ $s = 24; continue;
					/* if (!_r$3) { */ case 23:
						$s = -1; return false;
					/* } */ case 24:
					i$1 = i$1 + (1) >> 0;
				$s = 21; continue;
				case 22:
				$s = -1; return true;
			/* } else if (_1 === (20)) { */ case 5:
				t$1 = (T.kindType);
				v$1 = (V.kindType);
				if ((t$1.methods.$length === 0) && (v$1.methods.$length === 0)) {
					$s = -1; return true;
				}
				$s = -1; return false;
			/* } else if (_1 === (21)) { */ case 6:
				_r$4 = haveIdenticalType(T.Key(), V.Key(), cmpTags); /* */ $s = 27; case 27: if($c) { $c = false; _r$4 = _r$4.$blk(); } if (_r$4 && _r$4.$blk !== undefined) { break s; }
				if (!(_r$4)) { _v$2 = false; $s = 26; continue s; }
				_r$5 = haveIdenticalType(T.Elem(), V.Elem(), cmpTags); /* */ $s = 28; case 28: if($c) { $c = false; _r$5 = _r$5.$blk(); } if (_r$5 && _r$5.$blk !== undefined) { break s; }
				_v$2 = _r$5; case 26:
				$24r$2 = _v$2;
				$s = 29; case 29: return $24r$2;
			/* } else if ((_1 === (22)) || (_1 === (23))) { */ case 7:
				_r$6 = haveIdenticalType(T.Elem(), V.Elem(), cmpTags); /* */ $s = 30; case 30: if($c) { $c = false; _r$6 = _r$6.$blk(); } if (_r$6 && _r$6.$blk !== undefined) { break s; }
				$24r$3 = _r$6;
				$s = 31; case 31: return $24r$3;
			/* } else if (_1 === (25)) { */ case 8:
				t$2 = (T.kindType);
				v$2 = (V.kindType);
				if (!((t$2.fields.$length === v$2.fields.$length))) {
					$s = -1; return false;
				}
				if (!($clone(t$2.pkgPath, name).name() === $clone(v$2.pkgPath, name).name())) {
					$s = -1; return false;
				}
				_ref = t$2.fields;
				_i = 0;
				/* while (true) { */ case 32:
					/* if (!(_i < _ref.$length)) { break; } */ if(!(_i < _ref.$length)) { $s = 33; continue; }
					i$2 = _i;
					tf = (x = t$2.fields, ((i$2 < 0 || i$2 >= x.$length) ? ($throwRuntimeError("index out of range"), undefined) : x.$array[x.$offset + i$2]));
					vf = (x$1 = v$2.fields, ((i$2 < 0 || i$2 >= x$1.$length) ? ($throwRuntimeError("index out of range"), undefined) : x$1.$array[x$1.$offset + i$2]));
					if (!($clone(tf.name, name).name() === $clone(vf.name, name).name())) {
						$s = -1; return false;
					}
					_r$7 = haveIdenticalType(tf.typ, vf.typ, cmpTags); /* */ $s = 36; case 36: if($c) { $c = false; _r$7 = _r$7.$blk(); } if (_r$7 && _r$7.$blk !== undefined) { break s; }
					/* */ if (!_r$7) { $s = 34; continue; }
					/* */ $s = 35; continue;
					/* if (!_r$7) { */ case 34:
						$s = -1; return false;
					/* } */ case 35:
					if (cmpTags && !($clone(tf.name, name).tag() === $clone(vf.name, name).tag())) {
						$s = -1; return false;
					}
					if (!((tf.offset === vf.offset))) {
						$s = -1; return false;
					}
					if (!(tf.embedded() === vf.embedded())) {
						$s = -1; return false;
					}
					_i++;
				$s = 32; continue;
				case 33:
				$s = -1; return true;
			/* } */ case 9:
		case 1:
		$s = -1; return false;
		/* */ } return; } var $f = {$blk: haveIdenticalUnderlyingType, $c: true, $r, $24r, $24r$1, $24r$2, $24r$3, T, V, _1, _i, _r, _r$1, _r$2, _r$3, _r$4, _r$5, _r$6, _r$7, _ref, _v, _v$1, _v$2, cmpTags, i, i$1, i$2, kind, t, t$1, t$2, tf, v, v$1, v$2, vf, x, x$1, $s};return $f;
	};
	toType = function(t) {
		var t;
		if (t === ptrType$1.nil) {
			return $ifaceNil;
		}
		return t;
	};
	ifaceIndir = function(t) {
		var t;
		return ((t.kind & 32) >>> 0) === 0;
	};
	methodValueCallCodePtr = function() {
		var {$24r, _r, $s, $r, $c} = $restore(this, {});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		_r = abi.FuncPCABI0(new funcType$2(methodValueCall)); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		$24r = _r;
		$s = 2; case 2: return $24r;
		/* */ } return; } var $f = {$blk: methodValueCallCodePtr, $c: true, $r, $24r, _r, $s};return $f;
	};
	methodValueCall = function() {
		$throwRuntimeError("native function not implemented: reflect.methodValueCall");
	};
	init = function() {
		var {used, x, x$1, x$10, x$11, x$12, x$2, x$3, x$4, x$5, x$6, x$7, x$8, x$9, $s, $r, $c} = $restore(this, {});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		used = (function(i) {
			var i;
		});
		$r = used((x = new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$14.nil, 0, 0), new x.constructor.elem(x))); /* */ $s = 1; case 1: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = used((x$1 = new uncommonType.ptr(0, 0, 0, 0, sliceType$11.nil), new x$1.constructor.elem(x$1))); /* */ $s = 2; case 2: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = used((x$2 = new method.ptr(0, 0, 0, 0), new x$2.constructor.elem(x$2))); /* */ $s = 3; case 3: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = used((x$3 = new arrayType.ptr(new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$14.nil, 0, 0), ptrType$1.nil, ptrType$1.nil, 0), new x$3.constructor.elem(x$3))); /* */ $s = 4; case 4: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = used((x$4 = new chanType.ptr(new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$14.nil, 0, 0), ptrType$1.nil, 0), new x$4.constructor.elem(x$4))); /* */ $s = 5; case 5: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = used((x$5 = new funcType.ptr(new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$14.nil, 0, 0), 0, 0, sliceType$2.nil, sliceType$2.nil), new x$5.constructor.elem(x$5))); /* */ $s = 6; case 6: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = used((x$6 = new interfaceType.ptr(new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$14.nil, 0, 0), new name.ptr(ptrType$14.nil), sliceType$14.nil), new x$6.constructor.elem(x$6))); /* */ $s = 7; case 7: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = used((x$7 = new mapType.ptr(new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$14.nil, 0, 0), ptrType$1.nil, ptrType$1.nil, ptrType$1.nil, $throwNilPointerError, 0, 0, 0, 0), new x$7.constructor.elem(x$7))); /* */ $s = 8; case 8: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = used((x$8 = new ptrType.ptr(new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$14.nil, 0, 0), ptrType$1.nil), new x$8.constructor.elem(x$8))); /* */ $s = 9; case 9: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = used((x$9 = new sliceType.ptr(new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$14.nil, 0, 0), ptrType$1.nil), new x$9.constructor.elem(x$9))); /* */ $s = 10; case 10: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = used((x$10 = new structType.ptr(new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$14.nil, 0, 0), new name.ptr(ptrType$14.nil), sliceType$15.nil), new x$10.constructor.elem(x$10))); /* */ $s = 11; case 11: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = used((x$11 = new imethod.ptr(0, 0), new x$11.constructor.elem(x$11))); /* */ $s = 12; case 12: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = used((x$12 = new structField.ptr(new name.ptr(ptrType$14.nil), ptrType$1.nil, 0), new x$12.constructor.elem(x$12))); /* */ $s = 13; case 13: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		initialized = true;
		uint8Type = $assertType(TypeOf(new $Uint8(0)), ptrType$1);
		$s = -1; return;
		/* */ } return; } var $f = {$blk: init, $c: true, $r, used, x, x$1, x$10, x$11, x$12, x$2, x$3, x$4, x$5, x$6, x$7, x$8, x$9, $s};return $f;
	};
	New = function(typ) {
		var fl, pt, ptr, t, typ;
		if ($interfaceIsEqual(typ, $ifaceNil)) {
			$panic(new $String("reflect: New(nil)"));
		}
		t = $assertType(typ, ptrType$1);
		pt = t.ptrTo();
		ptr = unsafe_New(t);
		fl = 22;
		return new Value.ptr(pt, ptr, fl);
	};
	$pkg.New = New;
	jsType = function(typ) {
		var typ;
		return typ.jsType;
	};
	reflectType = function(typ) {
		var _1, _i, _i$1, _i$2, _i$3, _ref, _ref$1, _ref$2, _ref$3, dir, exported, exported$1, f, fields, i, i$1, i$2, i$3, i$4, i$5, imethods, in$1, m, m$1, m$2, methodSet, methods, out, outCount, params, reflectFields, reflectMethods, results, rt, typ, ut, xcount;
		if (typ.reflectType === undefined) {
			rt = new rtype.ptr(((($parseInt(typ.size) >> 0) >>> 0)), 0, 0, 0, 0, 0, ((($parseInt(typ.kind) >> 0) << 24 >>> 24)), $throwNilPointerError, ptrType$14.nil, resolveReflectName($clone(newName(internalStr(typ.string), "", !!(typ.exported), false), name)), 0);
			rt.jsType = typ;
			typ.reflectType = rt;
			methodSet = $methodSet(typ);
			if (!(($parseInt(methodSet.length) === 0)) || !!(typ.named)) {
				rt.tflag = (rt.tflag | (1)) >>> 0;
				if (!!(typ.named)) {
					rt.tflag = (rt.tflag | (4)) >>> 0;
				}
				reflectMethods = sliceType$11.nil;
				i = 0;
				while (true) {
					if (!(i < $parseInt(methodSet.length))) { break; }
					m = methodSet[i];
					exported = internalStr(m.pkg) === "";
					if (!exported) {
						i = i + (1) >> 0;
						continue;
					}
					reflectMethods = $append(reflectMethods, new method.ptr(resolveReflectName($clone(newMethodName(m), name)), newTypeOff(reflectType(m.typ)), 0, 0));
					i = i + (1) >> 0;
				}
				xcount = ((reflectMethods.$length << 16 >>> 16));
				i$1 = 0;
				while (true) {
					if (!(i$1 < $parseInt(methodSet.length))) { break; }
					m$1 = methodSet[i$1];
					exported$1 = internalStr(m$1.pkg) === "";
					if (exported$1) {
						i$1 = i$1 + (1) >> 0;
						continue;
					}
					reflectMethods = $append(reflectMethods, new method.ptr(resolveReflectName($clone(newMethodName(m$1), name)), newTypeOff(reflectType(m$1.typ)), 0, 0));
					i$1 = i$1 + (1) >> 0;
				}
				ut = new uncommonType.ptr(resolveReflectName($clone(newName(internalStr(typ.pkg), "", false, false), name)), (($parseInt(methodSet.length) << 16 >>> 16)), xcount, 0, reflectMethods);
				ut.jsType = typ;
				rt.uncommonType = ut;
			}
			_1 = rt.Kind();
			if (_1 === (17)) {
				setKindType(rt, new arrayType.ptr(new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$14.nil, 0, 0), reflectType(typ.elem), ptrType$1.nil, ((($parseInt(typ.len) >> 0) >>> 0))));
			} else if (_1 === (18)) {
				dir = 3;
				if (!!(typ.sendOnly)) {
					dir = 2;
				}
				if (!!(typ.recvOnly)) {
					dir = 1;
				}
				setKindType(rt, new chanType.ptr(new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$14.nil, 0, 0), reflectType(typ.elem), ((dir >>> 0))));
			} else if (_1 === (19)) {
				params = typ.params;
				in$1 = $makeSlice(sliceType$2, $parseInt(params.length));
				_ref = in$1;
				_i = 0;
				while (true) {
					if (!(_i < _ref.$length)) { break; }
					i$2 = _i;
					((i$2 < 0 || i$2 >= in$1.$length) ? ($throwRuntimeError("index out of range"), undefined) : in$1.$array[in$1.$offset + i$2] = reflectType(params[i$2]));
					_i++;
				}
				results = typ.results;
				out = $makeSlice(sliceType$2, $parseInt(results.length));
				_ref$1 = out;
				_i$1 = 0;
				while (true) {
					if (!(_i$1 < _ref$1.$length)) { break; }
					i$3 = _i$1;
					((i$3 < 0 || i$3 >= out.$length) ? ($throwRuntimeError("index out of range"), undefined) : out.$array[out.$offset + i$3] = reflectType(results[i$3]));
					_i$1++;
				}
				outCount = (($parseInt(results.length) << 16 >>> 16));
				if (!!(typ.variadic)) {
					outCount = (outCount | (32768)) >>> 0;
				}
				setKindType(rt, new funcType.ptr($clone(rt, rtype), (($parseInt(params.length) << 16 >>> 16)), outCount, in$1, out));
			} else if (_1 === (20)) {
				methods = typ.methods;
				imethods = $makeSlice(sliceType$14, $parseInt(methods.length));
				_ref$2 = imethods;
				_i$2 = 0;
				while (true) {
					if (!(_i$2 < _ref$2.$length)) { break; }
					i$4 = _i$2;
					m$2 = methods[i$4];
					imethod.copy(((i$4 < 0 || i$4 >= imethods.$length) ? ($throwRuntimeError("index out of range"), undefined) : imethods.$array[imethods.$offset + i$4]), new imethod.ptr(resolveReflectName($clone(newMethodName(m$2), name)), newTypeOff(reflectType(m$2.typ))));
					_i$2++;
				}
				setKindType(rt, new interfaceType.ptr($clone(rt, rtype), $clone(newName(internalStr(typ.pkg), "", false, false), name), imethods));
			} else if (_1 === (21)) {
				setKindType(rt, new mapType.ptr(new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$14.nil, 0, 0), reflectType(typ.key), reflectType(typ.elem), ptrType$1.nil, $throwNilPointerError, 0, 0, 0, 0));
			} else if (_1 === (22)) {
				setKindType(rt, new ptrType.ptr(new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$14.nil, 0, 0), reflectType(typ.elem)));
			} else if (_1 === (23)) {
				setKindType(rt, new sliceType.ptr(new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$14.nil, 0, 0), reflectType(typ.elem)));
			} else if (_1 === (25)) {
				fields = typ.fields;
				reflectFields = $makeSlice(sliceType$15, $parseInt(fields.length));
				_ref$3 = reflectFields;
				_i$3 = 0;
				while (true) {
					if (!(_i$3 < _ref$3.$length)) { break; }
					i$5 = _i$3;
					f = fields[i$5];
					structField.copy(((i$5 < 0 || i$5 >= reflectFields.$length) ? ($throwRuntimeError("index out of range"), undefined) : reflectFields.$array[reflectFields.$offset + i$5]), new structField.ptr($clone(newName(internalStr(f.name), internalStr(f.tag), !!(f.exported), !!(f.embedded)), name), reflectType(f.typ), ((i$5 >>> 0))));
					_i$3++;
				}
				setKindType(rt, new structType.ptr($clone(rt, rtype), $clone(newName(internalStr(typ.pkgPath), "", false, false), name), reflectFields));
			}
		}
		return ((typ.reflectType));
	};
	setKindType = function(rt, kindType) {
		var kindType, rt;
		rt.kindType = kindType;
		kindType.rtype = rt;
	};
	uncommonType.ptr.prototype.methods = function() {
		var t;
		t = this;
		return t._methods;
	};
	uncommonType.prototype.methods = function() { return this.$val.methods(); };
	uncommonType.ptr.prototype.exportedMethods = function() {
		var t;
		t = this;
		return $subslice(t._methods, 0, t.xcount, t.xcount);
	};
	uncommonType.prototype.exportedMethods = function() { return this.$val.exportedMethods(); };
	rtype.ptr.prototype.uncommon = function() {
		var obj, t;
		t = this;
		obj = t.uncommonType;
		if (obj === undefined) {
			return ptrType$10.nil;
		}
		return ((obj));
	};
	rtype.prototype.uncommon = function() { return this.$val.uncommon(); };
	funcType.ptr.prototype.in$ = function() {
		var t;
		t = this;
		return t._in;
	};
	funcType.prototype.in$ = function() { return this.$val.in$(); };
	funcType.ptr.prototype.out = function() {
		var t;
		t = this;
		return t._out;
	};
	funcType.prototype.out = function() { return this.$val.out(); };
	name.ptr.prototype.name = function() {
		var _entry, n, s;
		s = "";
		n = this;
		s = (_entry = $mapIndex(nameMap,ptrType$14.keyFor(n.bytes)), _entry !== undefined ? _entry.v : ptrType$18.nil).name;
		return s;
	};
	name.prototype.name = function() { return this.$val.name(); };
	name.ptr.prototype.tag = function() {
		var _entry, n, s;
		s = "";
		n = this;
		s = (_entry = $mapIndex(nameMap,ptrType$14.keyFor(n.bytes)), _entry !== undefined ? _entry.v : ptrType$18.nil).tag;
		return s;
	};
	name.prototype.tag = function() { return this.$val.tag(); };
	name.ptr.prototype.pkgPath = function() {
		var _entry, n;
		n = this;
		return (_entry = $mapIndex(nameMap,ptrType$14.keyFor(n.bytes)), _entry !== undefined ? _entry.v : ptrType$18.nil).pkgPath;
	};
	name.prototype.pkgPath = function() { return this.$val.pkgPath(); };
	name.ptr.prototype.isExported = function() {
		var _entry, n;
		n = this;
		return (_entry = $mapIndex(nameMap,ptrType$14.keyFor(n.bytes)), _entry !== undefined ? _entry.v : ptrType$18.nil).exported;
	};
	name.prototype.isExported = function() { return this.$val.isExported(); };
	name.ptr.prototype.embedded = function() {
		var _entry, n;
		n = this;
		return (_entry = $mapIndex(nameMap,ptrType$14.keyFor(n.bytes)), _entry !== undefined ? _entry.v : ptrType$18.nil).embedded;
	};
	name.prototype.embedded = function() { return this.$val.embedded(); };
	newName = function(n, tag, exported, embedded) {
		var _key, b, embedded, exported, n, tag;
		b = $newDataPointer(0, ptrType$14);
		_key = b; (nameMap || $throwRuntimeError("assignment to entry in nil map")).set(ptrType$14.keyFor(_key), { k: _key, v: new nameData.ptr(n, tag, exported, embedded, "") });
		return new name.ptr(b);
	};
	newMethodName = function(m) {
		var _key, b, m;
		b = $newDataPointer(0, ptrType$14);
		_key = b; (nameMap || $throwRuntimeError("assignment to entry in nil map")).set(ptrType$14.keyFor(_key), { k: _key, v: new nameData.ptr(internalStr(m.name), "", internalStr(m.pkg) === "", false, internalStr(m.pkg)) });
		return new name.ptr(b);
	};
	rtype.ptr.prototype.nameOff = function(off) {
		var off, t, x;
		t = this;
		return (x = ((off >> 0)), ((x < 0 || x >= nameOffList.$length) ? ($throwRuntimeError("index out of range"), undefined) : nameOffList.$array[nameOffList.$offset + x]));
	};
	rtype.prototype.nameOff = function(off) { return this.$val.nameOff(off); };
	resolveReflectName = function(n) {
		var i, n;
		i = nameOffList.$length;
		nameOffList = $append(nameOffList, n);
		return ((i >> 0));
	};
	rtype.ptr.prototype.typeOff = function(off) {
		var off, t, x;
		t = this;
		return (x = ((off >> 0)), ((x < 0 || x >= typeOffList.$length) ? ($throwRuntimeError("index out of range"), undefined) : typeOffList.$array[typeOffList.$offset + x]));
	};
	rtype.prototype.typeOff = function(off) { return this.$val.typeOff(off); };
	newTypeOff = function(t) {
		var i, t;
		i = typeOffList.$length;
		typeOffList = $append(typeOffList, t);
		return ((i >> 0));
	};
	internalStr = function(strObj) {
		var c, strObj;
		c = new structType$3.ptr("");
		c.str = strObj;
		return c.str;
	};
	isWrapped = function(typ) {
		var typ;
		return !!(jsType(typ).wrapped);
	};
	copyStruct = function(dst, src, typ) {
		var dst, fields, i, prop, src, typ;
		fields = jsType(typ).fields;
		i = 0;
		while (true) {
			if (!(i < $parseInt(fields.length))) { break; }
			prop = $internalize(fields[i].prop, $String);
			dst[$externalize(prop, $String)] = src[$externalize(prop, $String)];
			i = i + (1) >> 0;
		}
	};
	makeValue = function(t, v, fl) {
		var {$24r, $24r$1, _r, _r$1, _r$2, _r$3, _r$4, _r$5, _v, _v$1, fl, rt, t, v, $s, $r, $c} = $restore(this, {t, v, fl});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		_r = t.common(); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		rt = _r;
		_r$1 = t.Kind(); /* */ $s = 6; case 6: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
		if (_r$1 === 17) { _v$1 = true; $s = 5; continue s; }
		_r$2 = t.Kind(); /* */ $s = 7; case 7: if($c) { $c = false; _r$2 = _r$2.$blk(); } if (_r$2 && _r$2.$blk !== undefined) { break s; }
		_v$1 = _r$2 === 25; case 5:
		if (_v$1) { _v = true; $s = 4; continue s; }
		_r$3 = t.Kind(); /* */ $s = 8; case 8: if($c) { $c = false; _r$3 = _r$3.$blk(); } if (_r$3 && _r$3.$blk !== undefined) { break s; }
		_v = _r$3 === 22; case 4:
		/* */ if (_v) { $s = 2; continue; }
		/* */ $s = 3; continue;
		/* if (_v) { */ case 2:
			_r$4 = t.Kind(); /* */ $s = 9; case 9: if($c) { $c = false; _r$4 = _r$4.$blk(); } if (_r$4 && _r$4.$blk !== undefined) { break s; }
			$24r = new Value.ptr(rt, (v), (fl | ((_r$4 >>> 0))) >>> 0);
			$s = 10; case 10: return $24r;
		/* } */ case 3:
		_r$5 = t.Kind(); /* */ $s = 11; case 11: if($c) { $c = false; _r$5 = _r$5.$blk(); } if (_r$5 && _r$5.$blk !== undefined) { break s; }
		$24r$1 = new Value.ptr(rt, ($newDataPointer(v, jsType(rt.ptrTo()))), (((fl | ((_r$5 >>> 0))) >>> 0) | 128) >>> 0);
		$s = 12; case 12: return $24r$1;
		/* */ } return; } var $f = {$blk: makeValue, $c: true, $r, $24r, $24r$1, _r, _r$1, _r$2, _r$3, _r$4, _r$5, _v, _v$1, fl, rt, t, v, $s};return $f;
	};
	MakeSlice = function(typ, len, cap) {
		var {$24r, _r, _r$1, cap, len, typ, $s, $r, $c} = $restore(this, {typ, len, cap});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		typ = [typ];
		_r = typ[0].Kind(); /* */ $s = 3; case 3: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		/* */ if (!((_r === 23))) { $s = 1; continue; }
		/* */ $s = 2; continue;
		/* if (!((_r === 23))) { */ case 1:
			$panic(new $String("reflect.MakeSlice of non-slice type"));
		/* } */ case 2:
		if (len < 0) {
			$panic(new $String("reflect.MakeSlice: negative len"));
		}
		if (cap < 0) {
			$panic(new $String("reflect.MakeSlice: negative cap"));
		}
		if (len > cap) {
			$panic(new $String("reflect.MakeSlice: len > cap"));
		}
		_r$1 = makeValue(typ[0], $makeSlice(jsType(typ[0]), len, cap, (function(typ) { return function $b() {
			var {$24r, _r$1, _r$2, $s, $r, $c} = $restore(this, {});
			/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
			_r$1 = typ[0].Elem(); /* */ $s = 1; case 1: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
			_r$2 = jsType(_r$1); /* */ $s = 2; case 2: if($c) { $c = false; _r$2 = _r$2.$blk(); } if (_r$2 && _r$2.$blk !== undefined) { break s; }
			$24r = _r$2.zero();
			$s = 3; case 3: return $24r;
			/* */ } return; } var $f = {$blk: $b, $c: true, $r, $24r, _r$1, _r$2, $s};return $f;
		}; })(typ)), 0); /* */ $s = 4; case 4: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
		$24r = _r$1;
		$s = 5; case 5: return $24r;
		/* */ } return; } var $f = {$blk: MakeSlice, $c: true, $r, $24r, _r, _r$1, cap, len, typ, $s};return $f;
	};
	$pkg.MakeSlice = MakeSlice;
	TypeOf = function(i) {
		var i;
		if (!initialized) {
			return new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$14.nil, 0, 0);
		}
		if ($interfaceIsEqual(i, $ifaceNil)) {
			return $ifaceNil;
		}
		return reflectType(i.constructor);
	};
	$pkg.TypeOf = TypeOf;
	ValueOf = function(i) {
		var {$24r, _r, i, $s, $r, $c} = $restore(this, {i});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		if ($interfaceIsEqual(i, $ifaceNil)) {
			$s = -1; return new Value.ptr(ptrType$1.nil, 0, 0);
		}
		_r = makeValue(reflectType(i.constructor), i.$val, 0); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		$24r = _r;
		$s = 2; case 2: return $24r;
		/* */ } return; } var $f = {$blk: ValueOf, $c: true, $r, $24r, _r, i, $s};return $f;
	};
	$pkg.ValueOf = ValueOf;
	FuncOf = function(in$1, out, variadic) {
		var {_i, _i$1, _r, _ref, _ref$1, _v, _v$1, i, i$1, in$1, jsIn, jsOut, out, v, v$1, variadic, x, $s, $r, $c} = $restore(this, {in$1, out, variadic});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		if (!(variadic)) { _v = false; $s = 3; continue s; }
		if (in$1.$length === 0) { _v$1 = true; $s = 4; continue s; }
		_r = (x = in$1.$length - 1 >> 0, ((x < 0 || x >= in$1.$length) ? ($throwRuntimeError("index out of range"), undefined) : in$1.$array[in$1.$offset + x])).Kind(); /* */ $s = 5; case 5: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		_v$1 = !((_r === 23)); case 4:
		_v = _v$1; case 3:
		/* */ if (_v) { $s = 1; continue; }
		/* */ $s = 2; continue;
		/* if (_v) { */ case 1:
			$panic(new $String("reflect.FuncOf: last arg of variadic func must be slice"));
		/* } */ case 2:
		jsIn = $makeSlice(sliceType$16, in$1.$length);
		_ref = in$1;
		_i = 0;
		while (true) {
			if (!(_i < _ref.$length)) { break; }
			i = _i;
			v = ((_i < 0 || _i >= _ref.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref.$array[_ref.$offset + _i]);
			((i < 0 || i >= jsIn.$length) ? ($throwRuntimeError("index out of range"), undefined) : jsIn.$array[jsIn.$offset + i] = jsType(v));
			_i++;
		}
		jsOut = $makeSlice(sliceType$16, out.$length);
		_ref$1 = out;
		_i$1 = 0;
		while (true) {
			if (!(_i$1 < _ref$1.$length)) { break; }
			i$1 = _i$1;
			v$1 = ((_i$1 < 0 || _i$1 >= _ref$1.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref$1.$array[_ref$1.$offset + _i$1]);
			((i$1 < 0 || i$1 >= jsOut.$length) ? ($throwRuntimeError("index out of range"), undefined) : jsOut.$array[jsOut.$offset + i$1] = jsType(v$1));
			_i$1++;
		}
		$s = -1; return reflectType($funcType($externalize(jsIn, sliceType$16), $externalize(jsOut, sliceType$16), $externalize(variadic, $Bool)));
		/* */ } return; } var $f = {$blk: FuncOf, $c: true, $r, _i, _i$1, _r, _ref, _ref$1, _v, _v$1, i, i$1, in$1, jsIn, jsOut, out, v, v$1, variadic, x, $s};return $f;
	};
	$pkg.FuncOf = FuncOf;
	rtype.ptr.prototype.ptrTo = function() {
		var t;
		t = this;
		return reflectType($ptrType(jsType(t)));
	};
	rtype.prototype.ptrTo = function() { return this.$val.ptrTo(); };
	SliceOf = function(t) {
		var t;
		return reflectType($sliceType(jsType(t)));
	};
	$pkg.SliceOf = SliceOf;
	Zero = function(typ) {
		var {$24r, _r, typ, $s, $r, $c} = $restore(this, {typ});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		_r = makeValue(typ, jsType(typ).zero(), 0); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		$24r = _r;
		$s = 2; case 2: return $24r;
		/* */ } return; } var $f = {$blk: Zero, $c: true, $r, $24r, _r, typ, $s};return $f;
	};
	$pkg.Zero = Zero;
	unsafe_New = function(typ) {
		var _1, typ;
		_1 = typ.Kind();
		if (_1 === (25)) {
			return (new (jsType(typ).ptr)());
		} else if (_1 === (17)) {
			return (jsType(typ).zero());
		} else {
			return ($newDataPointer(jsType(typ).zero(), jsType(typ.ptrTo())));
		}
	};
	makeInt = function(f, bits, t) {
		var {_1, _r, bits, f, ptr, t, typ, $s, $r, $c} = $restore(this, {f, bits, t});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		_r = t.common(); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		typ = _r;
		ptr = unsafe_New(typ);
		_1 = typ.Kind();
		if (_1 === (3)) {
			(ptr).$set(((bits.$low << 24 >> 24)));
		} else if (_1 === (4)) {
			(ptr).$set(((bits.$low << 16 >> 16)));
		} else if ((_1 === (2)) || (_1 === (5))) {
			(ptr).$set(((bits.$low >> 0)));
		} else if (_1 === (6)) {
			(ptr).$set((new $Int64(bits.$high, bits.$low)));
		} else if (_1 === (8)) {
			(ptr).$set(((bits.$low << 24 >>> 24)));
		} else if (_1 === (9)) {
			(ptr).$set(((bits.$low << 16 >>> 16)));
		} else if ((_1 === (7)) || (_1 === (10)) || (_1 === (12))) {
			(ptr).$set(((bits.$low >>> 0)));
		} else if (_1 === (11)) {
			(ptr).$set((bits));
		}
		$s = -1; return new Value.ptr(typ, ptr, (((f | 128) >>> 0) | ((typ.Kind() >>> 0))) >>> 0);
		/* */ } return; } var $f = {$blk: makeInt, $c: true, $r, _1, _r, bits, f, ptr, t, typ, $s};return $f;
	};
	typedmemmove = function(t, dst, src) {
		var dst, src, t;
		dst.$set(src.$get());
	};
	keyFor = function(t, key) {
		var k, key, kv, t;
		kv = key;
		if (!(kv.$get === undefined)) {
			kv = kv.$get();
		}
		k = jsType(t.Key()).keyFor(kv);
		return [kv, k];
	};
	mapaccess = function(t, m, key) {
		var _tuple, entry, k, key, m, t;
		if (!!!(m)) {
			return 0;
		}
		_tuple = keyFor(t, key);
		k = _tuple[1];
		entry = m.get(k);
		if (entry === undefined) {
			return 0;
		}
		return ($newDataPointer(entry.v, jsType(PtrTo(t.Elem()))));
	};
	mapassign = function(t, m, key, val) {
		var {_r, _tuple, entry, et, jsVal, k, key, kv, m, newVal, t, val, $s, $r, $c} = $restore(this, {t, m, key, val});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		_tuple = keyFor(t, key);
		kv = _tuple[0];
		k = _tuple[1];
		jsVal = val.$get();
		et = t.Elem();
		_r = et.Kind(); /* */ $s = 3; case 3: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		/* */ if (_r === 25) { $s = 1; continue; }
		/* */ $s = 2; continue;
		/* if (_r === 25) { */ case 1:
			newVal = jsType(et).zero();
			copyStruct(newVal, jsVal, et);
			jsVal = newVal;
		/* } */ case 2:
		entry = new ($global.Object)();
		entry.k = kv;
		entry.v = jsVal;
		m.set(k, entry);
		$s = -1; return;
		/* */ } return; } var $f = {$blk: mapassign, $c: true, $r, _r, _tuple, entry, et, jsVal, k, key, kv, m, newVal, t, val, $s};return $f;
	};
	mapdelete = function(t, m, key) {
		var _tuple, k, key, m, t;
		_tuple = keyFor(t, key);
		k = _tuple[1];
		if (!!!(m)) {
			return;
		}
		m.delete(k);
	};
	mapaccess_faststr = function(t, m, key) {
		var key, key$24ptr, m, t, val;
		val = 0;
		val = mapaccess(t, m, ((key$24ptr || (key$24ptr = new ptrType$19(function() { return key; }, function($v) { key = $v; })))));
		return val;
	};
	mapassign_faststr = function(t, m, key, val) {
		var {key, m, t, val, $s, $r, $c} = $restore(this, {t, m, key, val});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		key = [key];
		$r = mapassign(t, m, ((key.$ptr || (key.$ptr = new ptrType$19(function() { return this.$target[0]; }, function($v) { this.$target[0] = $v; }, key)))), val); /* */ $s = 1; case 1: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$s = -1; return;
		/* */ } return; } var $f = {$blk: mapassign_faststr, $c: true, $r, key, m, t, val, $s};return $f;
	};
	mapdelete_faststr = function(t, m, key) {
		var key, key$24ptr, m, t;
		mapdelete(t, m, ((key$24ptr || (key$24ptr = new ptrType$19(function() { return key; }, function($v) { key = $v; })))));
	};
	hiter.ptr.prototype.skipUntilValidKey = function() {
		var entry, iter, k;
		iter = this;
		while (true) {
			if (!(iter.i < $parseInt(iter.keys.length))) { break; }
			k = iter.keys[iter.i];
			entry = iter.m.get(k);
			if (!(entry === undefined)) {
				break;
			}
			iter.i = iter.i + (1) >> 0;
		}
	};
	hiter.prototype.skipUntilValidKey = function() { return this.$val.skipUntilValidKey(); };
	mapiterinit = function(t, m, it) {
		var it, keys, keysIter, m, mapObj, t;
		mapObj = m;
		keys = new ($global.Array)();
		if (!(mapObj.keys === undefined)) {
			keysIter = mapObj.keys();
			if (!(mapObj.keys === undefined)) {
				keys = $global.Array.from(keysIter);
			}
		}
		hiter.copy(it, new hiter.ptr(t, mapObj, keys, 0, null));
	};
	mapiterkey = function(it) {
		var {$24r, _r, _r$1, _r$2, it, k, kv, $s, $r, $c} = $restore(this, {it});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		kv = null;
		if (!(it.last === null)) {
			kv = it.last;
		} else {
			it.skipUntilValidKey();
			if (it.i === $parseInt(it.keys.length)) {
				$s = -1; return 0;
			}
			k = it.keys[it.i];
			kv = it.m.get(k);
			it.last = kv;
		}
		_r = it.t.Key(); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		_r$1 = PtrTo(_r); /* */ $s = 2; case 2: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
		_r$2 = jsType(_r$1); /* */ $s = 3; case 3: if($c) { $c = false; _r$2 = _r$2.$blk(); } if (_r$2 && _r$2.$blk !== undefined) { break s; }
		$24r = ($newDataPointer(kv.k, _r$2));
		$s = 4; case 4: return $24r;
		/* */ } return; } var $f = {$blk: mapiterkey, $c: true, $r, $24r, _r, _r$1, _r$2, it, k, kv, $s};return $f;
	};
	mapiterelem = function(it) {
		var {$24r, _r, _r$1, _r$2, it, k, kv, $s, $r, $c} = $restore(this, {it});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		kv = null;
		if (!(it.last === null)) {
			kv = it.last;
		} else {
			it.skipUntilValidKey();
			if (it.i === $parseInt(it.keys.length)) {
				$s = -1; return 0;
			}
			k = it.keys[it.i];
			kv = it.m.get(k);
			it.last = kv;
		}
		_r = it.t.Elem(); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		_r$1 = PtrTo(_r); /* */ $s = 2; case 2: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
		_r$2 = jsType(_r$1); /* */ $s = 3; case 3: if($c) { $c = false; _r$2 = _r$2.$blk(); } if (_r$2 && _r$2.$blk !== undefined) { break s; }
		$24r = ($newDataPointer(kv.v, _r$2));
		$s = 4; case 4: return $24r;
		/* */ } return; } var $f = {$blk: mapiterelem, $c: true, $r, $24r, _r, _r$1, _r$2, it, k, kv, $s};return $f;
	};
	mapiternext = function(it) {
		var it;
		it.last = null;
		it.i = it.i + (1) >> 0;
	};
	maplen = function(m) {
		var m;
		return $parseInt(m.size) >> 0;
	};
	cvtDirect = function(v, typ) {
		var {$24r, $24r$1, _1, _2, _arg, _arg$1, _arg$2, _r, _r$1, _r$2, _r$3, _r$4, _r$5, _r$6, _r$7, k, slice, srcVal, typ, v, val, $s, $r, $c} = $restore(this, {v, typ});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		srcVal = $clone(v, Value).object();
		/* */ if (srcVal === jsType(v.typ).nil) { $s = 1; continue; }
		/* */ $s = 2; continue;
		/* if (srcVal === jsType(v.typ).nil) { */ case 1:
			_r = makeValue(typ, jsType(typ).nil, v.flag); /* */ $s = 3; case 3: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
			$24r = _r;
			$s = 4; case 4: return $24r;
		/* } */ case 2:
		val = null;
			_r$1 = typ.Kind(); /* */ $s = 6; case 6: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
			k = _r$1;
			_1 = k;
			/* */ if (_1 === (23)) { $s = 7; continue; }
			/* */ if (_1 === (22)) { $s = 8; continue; }
			/* */ if (_1 === (25)) { $s = 9; continue; }
			/* */ if ((_1 === (17)) || (_1 === (1)) || (_1 === (18)) || (_1 === (19)) || (_1 === (20)) || (_1 === (21)) || (_1 === (24)) || (_1 === (26))) { $s = 10; continue; }
			/* */ $s = 11; continue;
			/* if (_1 === (23)) { */ case 7:
				slice = new (jsType(typ))(srcVal.$array);
				slice.$offset = srcVal.$offset;
				slice.$length = srcVal.$length;
				slice.$capacity = srcVal.$capacity;
				val = $newDataPointer(slice, jsType(PtrTo(typ)));
				$s = 12; continue;
			/* } else if (_1 === (22)) { */ case 8:
					_r$2 = typ.Elem(); /* */ $s = 14; case 14: if($c) { $c = false; _r$2 = _r$2.$blk(); } if (_r$2 && _r$2.$blk !== undefined) { break s; }
					_r$3 = _r$2.Kind(); /* */ $s = 15; case 15: if($c) { $c = false; _r$3 = _r$3.$blk(); } if (_r$3 && _r$3.$blk !== undefined) { break s; }
					_2 = _r$3;
					/* */ if (_2 === (25)) { $s = 16; continue; }
					/* */ if (_2 === (17)) { $s = 17; continue; }
					/* */ $s = 18; continue;
					/* if (_2 === (25)) { */ case 16:
						_r$4 = typ.Elem(); /* */ $s = 22; case 22: if($c) { $c = false; _r$4 = _r$4.$blk(); } if (_r$4 && _r$4.$blk !== undefined) { break s; }
						/* */ if ($interfaceIsEqual(_r$4, v.typ.Elem())) { $s = 20; continue; }
						/* */ $s = 21; continue;
						/* if ($interfaceIsEqual(_r$4, v.typ.Elem())) { */ case 20:
							val = srcVal;
							/* break; */ $s = 13; continue;
						/* } */ case 21:
						val = new (jsType(typ))();
						_arg = val;
						_arg$1 = srcVal;
						_r$5 = typ.Elem(); /* */ $s = 23; case 23: if($c) { $c = false; _r$5 = _r$5.$blk(); } if (_r$5 && _r$5.$blk !== undefined) { break s; }
						_arg$2 = _r$5;
						$r = copyStruct(_arg, _arg$1, _arg$2); /* */ $s = 24; case 24: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
						$s = 19; continue;
					/* } else if (_2 === (17)) { */ case 17:
						val = srcVal;
						$s = 19; continue;
					/* } else { */ case 18:
						val = new (jsType(typ))(srcVal.$get, srcVal.$set);
					/* } */ case 19:
				case 13:
				$s = 12; continue;
			/* } else if (_1 === (25)) { */ case 9:
				val = new (jsType(typ).ptr)();
				copyStruct(val, srcVal, typ);
				$s = 12; continue;
			/* } else if ((_1 === (17)) || (_1 === (1)) || (_1 === (18)) || (_1 === (19)) || (_1 === (20)) || (_1 === (21)) || (_1 === (24)) || (_1 === (26))) { */ case 10:
				val = v.ptr;
				$s = 12; continue;
			/* } else { */ case 11:
				$panic(new ValueError.ptr("reflect.Convert", k));
			/* } */ case 12:
		case 5:
		_r$6 = typ.common(); /* */ $s = 25; case 25: if($c) { $c = false; _r$6 = _r$6.$blk(); } if (_r$6 && _r$6.$blk !== undefined) { break s; }
		_r$7 = typ.Kind(); /* */ $s = 26; case 26: if($c) { $c = false; _r$7 = _r$7.$blk(); } if (_r$7 && _r$7.$blk !== undefined) { break s; }
		$24r$1 = new Value.ptr(_r$6, (val), (((new flag(v.flag).ro() | ((v.flag & 128) >>> 0)) >>> 0) | ((_r$7 >>> 0))) >>> 0);
		$s = 27; case 27: return $24r$1;
		/* */ } return; } var $f = {$blk: cvtDirect, $c: true, $r, $24r, $24r$1, _1, _2, _arg, _arg$1, _arg$2, _r, _r$1, _r$2, _r$3, _r$4, _r$5, _r$6, _r$7, k, slice, srcVal, typ, v, val, $s};return $f;
	};
	cvtSliceArrayPtr = function(v, t) {
		var {$24r, _r, _r$1, _r$2, alen, array, slen, slice, t, v, $s, $r, $c} = $restore(this, {v, t});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		slice = $clone(v, Value).object();
		slen = $parseInt(slice.$length) >> 0;
		_r = t.Elem(); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		_r$1 = _r.Len(); /* */ $s = 2; case 2: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
		alen = _r$1;
		if (alen > slen) {
			$panic(new $String("reflect: cannot convert slice with length " + itoa.Itoa(slen) + " to pointer to array with length " + itoa.Itoa(alen)));
		}
		array = $sliceToGoArray(slice, jsType(t));
		_r$2 = t.common(); /* */ $s = 3; case 3: if($c) { $c = false; _r$2 = _r$2.$blk(); } if (_r$2 && _r$2.$blk !== undefined) { break s; }
		$24r = new Value.ptr(_r$2, (array), (((v.flag & ~415) >>> 0) | 22) >>> 0);
		$s = 4; case 4: return $24r;
		/* */ } return; } var $f = {$blk: cvtSliceArrayPtr, $c: true, $r, $24r, _r, _r$1, _r$2, alen, array, slen, slice, t, v, $s};return $f;
	};
	methodReceiver = function(op, v, i) {
		var _, fn, i, m, m$1, ms, op, prop, rcvr, t, tt, v, x;
		_ = ptrType$1.nil;
		t = ptrType$20.nil;
		fn = 0;
		prop = "";
		if (v.typ.Kind() === 20) {
			tt = (v.typ.kindType);
			if (i < 0 || i >= tt.methods.$length) {
				$panic(new $String("reflect: internal error: invalid method index"));
			}
			m = (x = tt.methods, ((i < 0 || i >= x.$length) ? ($throwRuntimeError("index out of range"), undefined) : x.$array[x.$offset + i]));
			if (!$clone(tt.rtype.nameOff(m.name), name).isExported()) {
				$panic(new $String("reflect: " + op + " of unexported method"));
			}
			t = (tt.rtype.typeOff(m.typ).kindType);
			prop = $clone(tt.rtype.nameOff(m.name), name).name();
		} else {
			ms = v.typ.exportedMethods();
			if (((i >>> 0)) >= ((ms.$length >>> 0))) {
				$panic(new $String("reflect: internal error: invalid method index"));
			}
			m$1 = $clone(((i < 0 || i >= ms.$length) ? ($throwRuntimeError("index out of range"), undefined) : ms.$array[ms.$offset + i]), method);
			if (!$clone(v.typ.nameOff(m$1.name), name).isExported()) {
				$panic(new $String("reflect: " + op + " of unexported method"));
			}
			t = (v.typ.typeOff(m$1.mtyp).kindType);
			prop = $internalize($methodSet(jsType(v.typ))[i].prop, $String);
		}
		rcvr = $clone(v, Value).object();
		if (isWrapped(v.typ)) {
			rcvr = new (jsType(v.typ))(rcvr);
		}
		fn = (rcvr[$externalize(prop, $String)]);
		return [_, t, fn];
	};
	valueInterface = function(v, safe) {
		var {_r, cv, safe, v, $s, $r, $c} = $restore(this, {v, safe});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		if (v.flag === 0) {
			$panic(new ValueError.ptr("reflect.Value.Interface", 0));
		}
		if (safe && !((((v.flag & 96) >>> 0) === 0))) {
			$panic(new $String("reflect.Value.Interface: cannot return value obtained from unexported field or method"));
		}
		/* */ if (!((((v.flag & 512) >>> 0) === 0))) { $s = 1; continue; }
		/* */ $s = 2; continue;
		/* if (!((((v.flag & 512) >>> 0) === 0))) { */ case 1:
			_r = makeMethodValue("Interface", $clone(v, Value)); /* */ $s = 3; case 3: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
			v = _r;
		/* } */ case 2:
		if (isWrapped(v.typ)) {
			if (!((((v.flag & 128) >>> 0) === 0)) && ($clone(v, Value).Kind() === 25)) {
				cv = jsType(v.typ).zero();
				copyStruct(cv, $clone(v, Value).object(), v.typ);
				$s = -1; return ((new (jsType(v.typ))(cv)));
			}
			$s = -1; return ((new (jsType(v.typ))($clone(v, Value).object())));
		}
		$s = -1; return (($clone(v, Value).object()));
		/* */ } return; } var $f = {$blk: valueInterface, $c: true, $r, _r, cv, safe, v, $s};return $f;
	};
	ifaceE2I = function(t, src, dst) {
		var dst, src, t;
		dst.$set(src);
	};
	makeMethodValue = function(op, v) {
		var {$24r, _r, _tuple, fn, fv, op, rcvr, v, $s, $r, $c} = $restore(this, {op, v});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		fn = [fn];
		rcvr = [rcvr];
		if (((v.flag & 512) >>> 0) === 0) {
			$panic(new $String("reflect: internal error: invalid use of makePartialFunc"));
		}
		_tuple = methodReceiver(op, $clone(v, Value), ((v.flag >> 0)) >> 10 >> 0);
		fn[0] = _tuple[2];
		rcvr[0] = $clone(v, Value).object();
		if (isWrapped(v.typ)) {
			rcvr[0] = new (jsType(v.typ))(rcvr[0]);
		}
		fv = js.MakeFunc((function(fn, rcvr) { return function(this$1, arguments$1) {
			var arguments$1, this$1;
			return new $jsObjectPtr(fn[0].apply(rcvr[0], $externalize(arguments$1, sliceType$16)));
		}; })(fn, rcvr));
		_r = $clone(v, Value).Type().common(); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		$24r = new Value.ptr(_r, (fv), (new flag(v.flag).ro() | 19) >>> 0);
		$s = 2; case 2: return $24r;
		/* */ } return; } var $f = {$blk: makeMethodValue, $c: true, $r, $24r, _r, _tuple, fn, fv, op, rcvr, v, $s};return $f;
	};
	rtype.ptr.prototype.pointers = function() {
		var _1, t;
		t = this;
		_1 = t.Kind();
		if ((_1 === (22)) || (_1 === (21)) || (_1 === (18)) || (_1 === (19)) || (_1 === (25)) || (_1 === (17))) {
			return true;
		} else {
			return false;
		}
	};
	rtype.prototype.pointers = function() { return this.$val.pointers(); };
	rtype.ptr.prototype.Comparable = function() {
		var {$24r, _1, _r, _r$1, i, t, $s, $r, $c} = $restore(this, {});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		t = this;
			_1 = t.Kind();
			/* */ if ((_1 === (19)) || (_1 === (23)) || (_1 === (21))) { $s = 2; continue; }
			/* */ if (_1 === (17)) { $s = 3; continue; }
			/* */ if (_1 === (25)) { $s = 4; continue; }
			/* */ $s = 5; continue;
			/* if ((_1 === (19)) || (_1 === (23)) || (_1 === (21))) { */ case 2:
				$s = -1; return false;
			/* } else if (_1 === (17)) { */ case 3:
				_r = t.Elem().Comparable(); /* */ $s = 6; case 6: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
				$24r = _r;
				$s = 7; case 7: return $24r;
			/* } else if (_1 === (25)) { */ case 4:
				i = 0;
				/* while (true) { */ case 8:
					/* if (!(i < t.NumField())) { break; } */ if(!(i < t.NumField())) { $s = 9; continue; }
					_r$1 = t.Field(i).Type.Comparable(); /* */ $s = 12; case 12: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
					/* */ if (!_r$1) { $s = 10; continue; }
					/* */ $s = 11; continue;
					/* if (!_r$1) { */ case 10:
						$s = -1; return false;
					/* } */ case 11:
					i = i + (1) >> 0;
				$s = 8; continue;
				case 9:
			/* } */ case 5:
		case 1:
		$s = -1; return true;
		/* */ } return; } var $f = {$blk: rtype.ptr.prototype.Comparable, $c: true, $r, $24r, _1, _r, _r$1, i, t, $s};return $f;
	};
	rtype.prototype.Comparable = function() { return this.$val.Comparable(); };
	rtype.ptr.prototype.Method = function(i) {
		var {_i, _i$1, _r, _ref, _ref$1, arg, fl, fn, ft, i, in$1, m, methods, mt, mtyp, out, p, pname, prop, ret, t, tt, $s, $r, $c} = $restore(this, {i});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		prop = [prop];
		m = new Method.ptr("", "", $ifaceNil, new Value.ptr(ptrType$1.nil, 0, 0), 0);
		t = this;
		if (t.Kind() === 20) {
			tt = (t.kindType);
			Method.copy(m, tt.Method(i));
			$s = -1; return m;
		}
		methods = t.exportedMethods();
		if (i < 0 || i >= methods.$length) {
			$panic(new $String("reflect: Method index out of range"));
		}
		p = $clone(((i < 0 || i >= methods.$length) ? ($throwRuntimeError("index out of range"), undefined) : methods.$array[methods.$offset + i]), method);
		pname = $clone(t.nameOff(p.name), name);
		m.Name = $clone(pname, name).name();
		fl = 19;
		mtyp = t.typeOff(p.mtyp);
		ft = (mtyp.kindType);
		in$1 = $makeSlice(sliceType$17, 0, (1 + ft.in$().$length >> 0));
		in$1 = $append(in$1, t);
		_ref = ft.in$();
		_i = 0;
		while (true) {
			if (!(_i < _ref.$length)) { break; }
			arg = ((_i < 0 || _i >= _ref.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref.$array[_ref.$offset + _i]);
			in$1 = $append(in$1, arg);
			_i++;
		}
		out = $makeSlice(sliceType$17, 0, ft.out().$length);
		_ref$1 = ft.out();
		_i$1 = 0;
		while (true) {
			if (!(_i$1 < _ref$1.$length)) { break; }
			ret = ((_i$1 < 0 || _i$1 >= _ref$1.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref$1.$array[_ref$1.$offset + _i$1]);
			out = $append(out, ret);
			_i$1++;
		}
		_r = FuncOf(in$1, out, ft.rtype.IsVariadic()); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		mt = _r;
		m.Type = mt;
		prop[0] = $internalize($methodSet(t.jsType)[i].prop, $String);
		fn = js.MakeFunc((function(prop) { return function(this$1, arguments$1) {
			var arguments$1, rcvr, this$1;
			rcvr = (0 >= arguments$1.$length ? ($throwRuntimeError("index out of range"), undefined) : arguments$1.$array[arguments$1.$offset + 0]);
			return new $jsObjectPtr(rcvr[$externalize(prop[0], $String)].apply(rcvr, $externalize($subslice(arguments$1, 1), sliceType$16)));
		}; })(prop));
		m.Func = new Value.ptr($assertType(mt, ptrType$1), (fn), fl);
		m.Index = i;
		Method.copy(m, m);
		$s = -1; return m;
		/* */ } return; } var $f = {$blk: rtype.ptr.prototype.Method, $c: true, $r, _i, _i$1, _r, _ref, _ref$1, arg, fl, fn, ft, i, in$1, m, methods, mt, mtyp, out, p, pname, prop, ret, t, tt, $s};return $f;
	};
	rtype.prototype.Method = function(i) { return this.$val.Method(i); };
	Value.ptr.prototype.object = function() {
		var _1, newVal, v, val;
		v = this;
		if ((v.typ.Kind() === 17) || (v.typ.Kind() === 25)) {
			return v.ptr;
		}
		if (!((((v.flag & 128) >>> 0) === 0))) {
			val = v.ptr.$get();
			if (!(val === $ifaceNil) && !(val.constructor === jsType(v.typ))) {
				switch (0) { default:
					_1 = v.typ.Kind();
					if ((_1 === (11)) || (_1 === (6))) {
						val = new (jsType(v.typ))(val.$high, val.$low);
					} else if ((_1 === (15)) || (_1 === (16))) {
						val = new (jsType(v.typ))(val.$real, val.$imag);
					} else if (_1 === (23)) {
						if (val === val.constructor.nil) {
							val = jsType(v.typ).nil;
							break;
						}
						newVal = new (jsType(v.typ))(val.$array);
						newVal.$offset = val.$offset;
						newVal.$length = val.$length;
						newVal.$capacity = val.$capacity;
						val = newVal;
					}
				}
			}
			return val;
		}
		return v.ptr;
	};
	Value.prototype.object = function() { return this.$val.object(); };
	Value.ptr.prototype.assignTo = function(context, dst, target) {
		var {_r, _r$1, _r$2, context, dst, fl, target, v, x, $s, $r, $c} = $restore(this, {context, dst, target});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		v = this;
		/* */ if (!((((v.flag & 512) >>> 0) === 0))) { $s = 1; continue; }
		/* */ $s = 2; continue;
		/* if (!((((v.flag & 512) >>> 0) === 0))) { */ case 1:
			_r = makeMethodValue(context, $clone(v, Value)); /* */ $s = 3; case 3: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
			v = _r;
		/* } */ case 2:
			_r$1 = directlyAssignable(dst, v.typ); /* */ $s = 8; case 8: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
			/* */ if (_r$1) { $s = 5; continue; }
			/* */ if (implements$1(dst, v.typ)) { $s = 6; continue; }
			/* */ $s = 7; continue;
			/* if (_r$1) { */ case 5:
				fl = (((v.flag & 384) >>> 0) | new flag(v.flag).ro()) >>> 0;
				fl = (fl | (((dst.Kind() >>> 0)))) >>> 0;
				$s = -1; return new Value.ptr(dst, v.ptr, fl);
			/* } else if (implements$1(dst, v.typ)) { */ case 6:
				if (target === 0) {
					target = unsafe_New(dst);
				}
				_r$2 = valueInterface($clone(v, Value), false); /* */ $s = 9; case 9: if($c) { $c = false; _r$2 = _r$2.$blk(); } if (_r$2 && _r$2.$blk !== undefined) { break s; }
				x = _r$2;
				if (dst.NumMethod() === 0) {
					(target).$set(x);
				} else {
					ifaceE2I(dst, x, target);
				}
				$s = -1; return new Value.ptr(dst, target, 148);
			/* } */ case 7:
		case 4:
		$panic(new $String(context + ": value of type " + v.typ.String() + " is not assignable to type " + dst.String()));
		$s = -1; return new Value.ptr(ptrType$1.nil, 0, 0);
		/* */ } return; } var $f = {$blk: Value.ptr.prototype.assignTo, $c: true, $r, _r, _r$1, _r$2, context, dst, fl, target, v, x, $s};return $f;
	};
	Value.prototype.assignTo = function(context, dst, target) { return this.$val.assignTo(context, dst, target); };
	Value.ptr.prototype.call = function(op, in$1) {
		var {$24r, _1, _arg, _arg$1, _arg$2, _arg$3, _i, _i$1, _i$2, _r, _r$1, _r$10, _r$11, _r$12, _r$13, _r$14, _r$15, _r$2, _r$3, _r$4, _r$5, _r$6, _r$7, _r$8, _r$9, _ref, _ref$1, _ref$2, _tmp, _tmp$1, _tuple, arg, argsArray, elem, fn, i, i$1, i$2, i$3, in$1, isSlice, m, n, nin, nout, op, origIn, rcvr, results, ret, slice, t, targ, v, x, x$1, x$2, xt, xt$1, $s, $r, $c} = $restore(this, {op, in$1});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		v = this;
		t = ptrType$20.nil;
		fn = 0;
		rcvr = null;
		if (!((((v.flag & 512) >>> 0) === 0))) {
			_tuple = methodReceiver(op, $clone(v, Value), ((v.flag >> 0)) >> 10 >> 0);
			t = _tuple[1];
			fn = _tuple[2];
			rcvr = $clone(v, Value).object();
			if (isWrapped(v.typ)) {
				rcvr = new (jsType(v.typ))(rcvr);
			}
		} else {
			t = (v.typ.kindType);
			fn = ($clone(v, Value).object());
			rcvr = undefined;
		}
		if (fn === 0) {
			$panic(new $String("reflect.Value.Call: call of nil function"));
		}
		isSlice = op === "CallSlice";
		n = t.rtype.NumIn();
		if (isSlice) {
			if (!t.rtype.IsVariadic()) {
				$panic(new $String("reflect: CallSlice of non-variadic function"));
			}
			if (in$1.$length < n) {
				$panic(new $String("reflect: CallSlice with too few input arguments"));
			}
			if (in$1.$length > n) {
				$panic(new $String("reflect: CallSlice with too many input arguments"));
			}
		} else {
			if (t.rtype.IsVariadic()) {
				n = n - (1) >> 0;
			}
			if (in$1.$length < n) {
				$panic(new $String("reflect: Call with too few input arguments"));
			}
			if (!t.rtype.IsVariadic() && in$1.$length > n) {
				$panic(new $String("reflect: Call with too many input arguments"));
			}
		}
		_ref = in$1;
		_i = 0;
		while (true) {
			if (!(_i < _ref.$length)) { break; }
			x = ((_i < 0 || _i >= _ref.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref.$array[_ref.$offset + _i]);
			if ($clone(x, Value).Kind() === 0) {
				$panic(new $String("reflect: " + op + " using zero Value argument"));
			}
			_i++;
		}
		i = 0;
		/* while (true) { */ case 1:
			/* if (!(i < n)) { break; } */ if(!(i < n)) { $s = 2; continue; }
			_tmp = $clone(((i < 0 || i >= in$1.$length) ? ($throwRuntimeError("index out of range"), undefined) : in$1.$array[in$1.$offset + i]), Value).Type();
			_tmp$1 = t.rtype.In(i);
			xt = _tmp;
			targ = _tmp$1;
			_r = xt.AssignableTo(targ); /* */ $s = 5; case 5: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
			/* */ if (!_r) { $s = 3; continue; }
			/* */ $s = 4; continue;
			/* if (!_r) { */ case 3:
				_r$1 = xt.String(); /* */ $s = 6; case 6: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
				_r$2 = targ.String(); /* */ $s = 7; case 7: if($c) { $c = false; _r$2 = _r$2.$blk(); } if (_r$2 && _r$2.$blk !== undefined) { break s; }
				$panic(new $String("reflect: " + op + " using " + _r$1 + " as type " + _r$2));
			/* } */ case 4:
			i = i + (1) >> 0;
		$s = 1; continue;
		case 2:
		/* */ if (!isSlice && t.rtype.IsVariadic()) { $s = 8; continue; }
		/* */ $s = 9; continue;
		/* if (!isSlice && t.rtype.IsVariadic()) { */ case 8:
			m = in$1.$length - n >> 0;
			_r$3 = MakeSlice(t.rtype.In(n), m, m); /* */ $s = 10; case 10: if($c) { $c = false; _r$3 = _r$3.$blk(); } if (_r$3 && _r$3.$blk !== undefined) { break s; }
			slice = _r$3;
			_r$4 = t.rtype.In(n).Elem(); /* */ $s = 11; case 11: if($c) { $c = false; _r$4 = _r$4.$blk(); } if (_r$4 && _r$4.$blk !== undefined) { break s; }
			elem = _r$4;
			i$1 = 0;
			/* while (true) { */ case 12:
				/* if (!(i$1 < m)) { break; } */ if(!(i$1 < m)) { $s = 13; continue; }
				x$2 = (x$1 = n + i$1 >> 0, ((x$1 < 0 || x$1 >= in$1.$length) ? ($throwRuntimeError("index out of range"), undefined) : in$1.$array[in$1.$offset + x$1]));
				xt$1 = $clone(x$2, Value).Type();
				_r$5 = xt$1.AssignableTo(elem); /* */ $s = 16; case 16: if($c) { $c = false; _r$5 = _r$5.$blk(); } if (_r$5 && _r$5.$blk !== undefined) { break s; }
				/* */ if (!_r$5) { $s = 14; continue; }
				/* */ $s = 15; continue;
				/* if (!_r$5) { */ case 14:
					_r$6 = xt$1.String(); /* */ $s = 17; case 17: if($c) { $c = false; _r$6 = _r$6.$blk(); } if (_r$6 && _r$6.$blk !== undefined) { break s; }
					_r$7 = elem.String(); /* */ $s = 18; case 18: if($c) { $c = false; _r$7 = _r$7.$blk(); } if (_r$7 && _r$7.$blk !== undefined) { break s; }
					$panic(new $String("reflect: cannot use " + _r$6 + " as type " + _r$7 + " in " + op));
				/* } */ case 15:
				_r$8 = $clone(slice, Value).Index(i$1); /* */ $s = 19; case 19: if($c) { $c = false; _r$8 = _r$8.$blk(); } if (_r$8 && _r$8.$blk !== undefined) { break s; }
				$r = $clone(_r$8, Value).Set($clone(x$2, Value)); /* */ $s = 20; case 20: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
				i$1 = i$1 + (1) >> 0;
			$s = 12; continue;
			case 13:
			origIn = in$1;
			in$1 = $makeSlice(sliceType$8, (n + 1 >> 0));
			$copySlice($subslice(in$1, 0, n), origIn);
			((n < 0 || n >= in$1.$length) ? ($throwRuntimeError("index out of range"), undefined) : in$1.$array[in$1.$offset + n] = slice);
		/* } */ case 9:
		nin = in$1.$length;
		if (!((nin === t.rtype.NumIn()))) {
			$panic(new $String("reflect.Value.Call: wrong argument count"));
		}
		nout = t.rtype.NumOut();
		argsArray = new ($global.Array)(t.rtype.NumIn());
		_ref$1 = in$1;
		_i$1 = 0;
		/* while (true) { */ case 21:
			/* if (!(_i$1 < _ref$1.$length)) { break; } */ if(!(_i$1 < _ref$1.$length)) { $s = 22; continue; }
			i$2 = _i$1;
			arg = ((_i$1 < 0 || _i$1 >= _ref$1.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref$1.$array[_ref$1.$offset + _i$1]);
			_arg = t.rtype.In(i$2);
			_r$9 = t.rtype.In(i$2).common(); /* */ $s = 23; case 23: if($c) { $c = false; _r$9 = _r$9.$blk(); } if (_r$9 && _r$9.$blk !== undefined) { break s; }
			_arg$1 = _r$9;
			_arg$2 = 0;
			_r$10 = $clone(arg, Value).assignTo("reflect.Value.Call", _arg$1, _arg$2); /* */ $s = 24; case 24: if($c) { $c = false; _r$10 = _r$10.$blk(); } if (_r$10 && _r$10.$blk !== undefined) { break s; }
			_r$11 = $clone(_r$10, Value).object(); /* */ $s = 25; case 25: if($c) { $c = false; _r$11 = _r$11.$blk(); } if (_r$11 && _r$11.$blk !== undefined) { break s; }
			_arg$3 = _r$11;
			_r$12 = unwrapJsObject(_arg, _arg$3); /* */ $s = 26; case 26: if($c) { $c = false; _r$12 = _r$12.$blk(); } if (_r$12 && _r$12.$blk !== undefined) { break s; }
			argsArray[i$2] = _r$12;
			_i$1++;
		$s = 21; continue;
		case 22:
		_r$13 = callHelper(new sliceType$5([new $jsObjectPtr(fn), new $jsObjectPtr(rcvr), new $jsObjectPtr(argsArray)])); /* */ $s = 27; case 27: if($c) { $c = false; _r$13 = _r$13.$blk(); } if (_r$13 && _r$13.$blk !== undefined) { break s; }
		results = _r$13;
			_1 = nout;
			/* */ if (_1 === (0)) { $s = 29; continue; }
			/* */ if (_1 === (1)) { $s = 30; continue; }
			/* */ $s = 31; continue;
			/* if (_1 === (0)) { */ case 29:
				$s = -1; return sliceType$8.nil;
			/* } else if (_1 === (1)) { */ case 30:
				_r$14 = makeValue(t.rtype.Out(0), wrapJsObject(t.rtype.Out(0), results), 0); /* */ $s = 33; case 33: if($c) { $c = false; _r$14 = _r$14.$blk(); } if (_r$14 && _r$14.$blk !== undefined) { break s; }
				$24r = new sliceType$8([$clone(_r$14, Value)]);
				$s = 34; case 34: return $24r;
			/* } else { */ case 31:
				ret = $makeSlice(sliceType$8, nout);
				_ref$2 = ret;
				_i$2 = 0;
				/* while (true) { */ case 35:
					/* if (!(_i$2 < _ref$2.$length)) { break; } */ if(!(_i$2 < _ref$2.$length)) { $s = 36; continue; }
					i$3 = _i$2;
					_r$15 = makeValue(t.rtype.Out(i$3), wrapJsObject(t.rtype.Out(i$3), results[i$3]), 0); /* */ $s = 37; case 37: if($c) { $c = false; _r$15 = _r$15.$blk(); } if (_r$15 && _r$15.$blk !== undefined) { break s; }
					((i$3 < 0 || i$3 >= ret.$length) ? ($throwRuntimeError("index out of range"), undefined) : ret.$array[ret.$offset + i$3] = _r$15);
					_i$2++;
				$s = 35; continue;
				case 36:
				$s = -1; return ret;
			/* } */ case 32:
		case 28:
		$s = -1; return sliceType$8.nil;
		/* */ } return; } var $f = {$blk: Value.ptr.prototype.call, $c: true, $r, $24r, _1, _arg, _arg$1, _arg$2, _arg$3, _i, _i$1, _i$2, _r, _r$1, _r$10, _r$11, _r$12, _r$13, _r$14, _r$15, _r$2, _r$3, _r$4, _r$5, _r$6, _r$7, _r$8, _r$9, _ref, _ref$1, _ref$2, _tmp, _tmp$1, _tuple, arg, argsArray, elem, fn, i, i$1, i$2, i$3, in$1, isSlice, m, n, nin, nout, op, origIn, rcvr, results, ret, slice, t, targ, v, x, x$1, x$2, xt, xt$1, $s};return $f;
	};
	Value.prototype.call = function(op, in$1) { return this.$val.call(op, in$1); };
	Value.ptr.prototype.Cap = function() {
		var {$24r, _1, _r, _r$1, k, v, $s, $r, $c} = $restore(this, {});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		v = this;
		k = new flag(v.flag).kind();
			_1 = k;
			/* */ if (_1 === (17)) { $s = 2; continue; }
			/* */ if ((_1 === (18)) || (_1 === (23))) { $s = 3; continue; }
			/* */ if (_1 === (22)) { $s = 4; continue; }
			/* */ $s = 5; continue;
			/* if (_1 === (17)) { */ case 2:
				$s = -1; return v.typ.Len();
			/* } else if ((_1 === (18)) || (_1 === (23))) { */ case 3:
				$s = -1; return $parseInt($clone(v, Value).object().$capacity) >> 0;
			/* } else if (_1 === (22)) { */ case 4:
				_r = v.typ.Elem().Kind(); /* */ $s = 8; case 8: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
				/* */ if (_r === 17) { $s = 6; continue; }
				/* */ $s = 7; continue;
				/* if (_r === 17) { */ case 6:
					_r$1 = v.typ.Elem().Len(); /* */ $s = 9; case 9: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
					$24r = _r$1;
					$s = 10; case 10: return $24r;
				/* } */ case 7:
				$panic(new $String("reflect: call of reflect.Value.Cap on ptr to non-array Value"));
			/* } */ case 5:
		case 1:
		$panic(new ValueError.ptr("reflect.Value.Cap", k));
		$s = -1; return 0;
		/* */ } return; } var $f = {$blk: Value.ptr.prototype.Cap, $c: true, $r, $24r, _1, _r, _r$1, k, v, $s};return $f;
	};
	Value.prototype.Cap = function() { return this.$val.Cap(); };
	wrapJsObject = function(typ, val) {
		var typ, val;
		if ($interfaceIsEqual(typ, jsObjectPtr)) {
			return new (jsType(jsObjectPtr))(val);
		}
		return val;
	};
	unwrapJsObject = function(typ, val) {
		var typ, val;
		if ($interfaceIsEqual(typ, jsObjectPtr)) {
			return val.object;
		}
		return val;
	};
	Value.ptr.prototype.Elem = function() {
		var {$24r, _1, _r, fl, k, tt, typ, v, val, val$1, $s, $r, $c} = $restore(this, {});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		v = this;
			k = new flag(v.flag).kind();
			_1 = k;
			/* */ if (_1 === (20)) { $s = 2; continue; }
			/* */ if (_1 === (22)) { $s = 3; continue; }
			/* */ $s = 4; continue;
			/* if (_1 === (20)) { */ case 2:
				val = $clone(v, Value).object();
				if (val === $ifaceNil) {
					$s = -1; return new Value.ptr(ptrType$1.nil, 0, 0);
				}
				typ = reflectType(val.constructor);
				_r = makeValue(typ, val.$val, new flag(v.flag).ro()); /* */ $s = 6; case 6: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
				$24r = _r;
				$s = 7; case 7: return $24r;
			/* } else if (_1 === (22)) { */ case 3:
				if ($clone(v, Value).IsNil()) {
					$s = -1; return new Value.ptr(ptrType$1.nil, 0, 0);
				}
				val$1 = $clone(v, Value).object();
				tt = (v.typ.kindType);
				fl = (((((v.flag & 96) >>> 0) | 128) >>> 0) | 256) >>> 0;
				fl = (fl | (((tt.elem.Kind() >>> 0)))) >>> 0;
				$s = -1; return new Value.ptr(tt.elem, (wrapJsObject(tt.elem, val$1)), fl);
			/* } else { */ case 4:
				$panic(new ValueError.ptr("reflect.Value.Elem", k));
			/* } */ case 5:
		case 1:
		$s = -1; return new Value.ptr(ptrType$1.nil, 0, 0);
		/* */ } return; } var $f = {$blk: Value.ptr.prototype.Elem, $c: true, $r, $24r, _1, _r, fl, k, tt, typ, v, val, val$1, $s};return $f;
	};
	Value.prototype.Elem = function() { return this.$val.Elem(); };
	Value.ptr.prototype.Field = function(i) {
		var {$24r, _r, _r$1, _r$2, field, fl, i, jsTag, o, prop, s, tag, tt, typ, v, x, x$1, $s, $r, $c} = $restore(this, {i});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		jsTag = [jsTag];
		prop = [prop];
		s = [s];
		typ = [typ];
		v = this;
		if (!((new flag(v.flag).kind() === 25))) {
			$panic(new ValueError.ptr("reflect.Value.Field", new flag(v.flag).kind()));
		}
		tt = (v.typ.kindType);
		if (((i >>> 0)) >= ((tt.fields.$length >>> 0))) {
			$panic(new $String("reflect: Field index out of range"));
		}
		prop[0] = $internalize(jsType(v.typ).fields[i].prop, $String);
		field = (x = tt.fields, ((i < 0 || i >= x.$length) ? ($throwRuntimeError("index out of range"), undefined) : x.$array[x.$offset + i]));
		typ[0] = field.typ;
		fl = (((v.flag & 416) >>> 0) | ((typ[0].Kind() >>> 0))) >>> 0;
		if (!$clone(field.name, name).isExported()) {
			if (field.embedded()) {
				fl = (fl | (64)) >>> 0;
			} else {
				fl = (fl | (32)) >>> 0;
			}
		}
		tag = $clone((x$1 = tt.fields, ((i < 0 || i >= x$1.$length) ? ($throwRuntimeError("index out of range"), undefined) : x$1.$array[x$1.$offset + i])).name, name).tag();
		/* */ if (!(tag === "") && !((i === 0))) { $s = 1; continue; }
		/* */ $s = 2; continue;
		/* if (!(tag === "") && !((i === 0))) { */ case 1:
			jsTag[0] = getJsTag(tag);
			/* */ if (!(jsTag[0] === "")) { $s = 3; continue; }
			/* */ $s = 4; continue;
			/* if (!(jsTag[0] === "")) { */ case 3:
				/* while (true) { */ case 5:
					o = [o];
					_r = $clone(v, Value).Field(0); /* */ $s = 7; case 7: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
					v = _r;
					/* */ if (v.typ === jsObjectPtr) { $s = 8; continue; }
					/* */ $s = 9; continue;
					/* if (v.typ === jsObjectPtr) { */ case 8:
						o[0] = $clone(v, Value).object().object;
						$s = -1; return new Value.ptr(typ[0], (new (jsType(PtrTo(typ[0])))((function(jsTag, o, prop, s, typ) { return function() {
							return $internalize(o[0][$externalize(jsTag[0], $String)], jsType(typ[0]));
						}; })(jsTag, o, prop, s, typ), (function(jsTag, o, prop, s, typ) { return function(x$2) {
							var x$2;
							o[0][$externalize(jsTag[0], $String)] = $externalize(x$2, jsType(typ[0]));
						}; })(jsTag, o, prop, s, typ))), fl);
					/* } */ case 9:
					/* */ if (v.typ.Kind() === 22) { $s = 10; continue; }
					/* */ $s = 11; continue;
					/* if (v.typ.Kind() === 22) { */ case 10:
						_r$1 = $clone(v, Value).Elem(); /* */ $s = 12; case 12: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
						v = _r$1;
					/* } */ case 11:
				$s = 5; continue;
				case 6:
			/* } */ case 4:
		/* } */ case 2:
		s[0] = v.ptr;
		/* */ if (!((((fl & 128) >>> 0) === 0)) && !((typ[0].Kind() === 17)) && !((typ[0].Kind() === 25))) { $s = 13; continue; }
		/* */ $s = 14; continue;
		/* if (!((((fl & 128) >>> 0) === 0)) && !((typ[0].Kind() === 17)) && !((typ[0].Kind() === 25))) { */ case 13:
			$s = -1; return new Value.ptr(typ[0], (new (jsType(PtrTo(typ[0])))((function(jsTag, prop, s, typ) { return function() {
				return wrapJsObject(typ[0], s[0][$externalize(prop[0], $String)]);
			}; })(jsTag, prop, s, typ), (function(jsTag, prop, s, typ) { return function(x$2) {
				var x$2;
				s[0][$externalize(prop[0], $String)] = unwrapJsObject(typ[0], x$2);
			}; })(jsTag, prop, s, typ))), fl);
		/* } */ case 14:
		_r$2 = makeValue(typ[0], wrapJsObject(typ[0], s[0][$externalize(prop[0], $String)]), fl); /* */ $s = 15; case 15: if($c) { $c = false; _r$2 = _r$2.$blk(); } if (_r$2 && _r$2.$blk !== undefined) { break s; }
		$24r = _r$2;
		$s = 16; case 16: return $24r;
		/* */ } return; } var $f = {$blk: Value.ptr.prototype.Field, $c: true, $r, $24r, _r, _r$1, _r$2, field, fl, i, jsTag, o, prop, s, tag, tt, typ, v, x, x$1, $s};return $f;
	};
	Value.prototype.Field = function(i) { return this.$val.Field(i); };
	getJsTag = function(tag) {
		var _tuple, i, name$1, qvalue, tag, value;
		while (true) {
			if (!(!(tag === ""))) { break; }
			i = 0;
			while (true) {
				if (!(i < tag.length && (tag.charCodeAt(i) === 32))) { break; }
				i = i + (1) >> 0;
			}
			tag = $substring(tag, i);
			if (tag === "") {
				break;
			}
			i = 0;
			while (true) {
				if (!(i < tag.length && !((tag.charCodeAt(i) === 32)) && !((tag.charCodeAt(i) === 58)) && !((tag.charCodeAt(i) === 34)))) { break; }
				i = i + (1) >> 0;
			}
			if ((i + 1 >> 0) >= tag.length || !((tag.charCodeAt(i) === 58)) || !((tag.charCodeAt((i + 1 >> 0)) === 34))) {
				break;
			}
			name$1 = ($substring(tag, 0, i));
			tag = $substring(tag, (i + 1 >> 0));
			i = 1;
			while (true) {
				if (!(i < tag.length && !((tag.charCodeAt(i) === 34)))) { break; }
				if (tag.charCodeAt(i) === 92) {
					i = i + (1) >> 0;
				}
				i = i + (1) >> 0;
			}
			if (i >= tag.length) {
				break;
			}
			qvalue = ($substring(tag, 0, (i + 1 >> 0)));
			tag = $substring(tag, (i + 1 >> 0));
			if (name$1 === "js") {
				_tuple = strconv.Unquote(qvalue);
				value = _tuple[0];
				return value;
			}
		}
		return "";
	};
	Value.ptr.prototype.Index = function(i) {
		var {$24r, $24r$1, _1, _r, _r$1, a, a$1, c, fl, fl$1, fl$2, i, k, s, str, tt, tt$1, typ, typ$1, v, $s, $r, $c} = $restore(this, {i});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		a = [a];
		a$1 = [a$1];
		c = [c];
		i = [i];
		typ = [typ];
		typ$1 = [typ$1];
		v = this;
			k = new flag(v.flag).kind();
			_1 = k;
			/* */ if (_1 === (17)) { $s = 2; continue; }
			/* */ if (_1 === (23)) { $s = 3; continue; }
			/* */ if (_1 === (24)) { $s = 4; continue; }
			/* */ $s = 5; continue;
			/* if (_1 === (17)) { */ case 2:
				tt = (v.typ.kindType);
				if (i[0] < 0 || i[0] > ((tt.len >> 0))) {
					$panic(new $String("reflect: array index out of range"));
				}
				typ[0] = tt.elem;
				fl = (((((v.flag & 384) >>> 0) | new flag(v.flag).ro()) >>> 0) | ((typ[0].Kind() >>> 0))) >>> 0;
				a[0] = v.ptr;
				/* */ if (!((((fl & 128) >>> 0) === 0)) && !((typ[0].Kind() === 17)) && !((typ[0].Kind() === 25))) { $s = 7; continue; }
				/* */ $s = 8; continue;
				/* if (!((((fl & 128) >>> 0) === 0)) && !((typ[0].Kind() === 17)) && !((typ[0].Kind() === 25))) { */ case 7:
					$s = -1; return new Value.ptr(typ[0], (new (jsType(PtrTo(typ[0])))((function(a, a$1, c, i, typ, typ$1) { return function() {
						return wrapJsObject(typ[0], a[0][i[0]]);
					}; })(a, a$1, c, i, typ, typ$1), (function(a, a$1, c, i, typ, typ$1) { return function(x) {
						var x;
						a[0][i[0]] = unwrapJsObject(typ[0], x);
					}; })(a, a$1, c, i, typ, typ$1))), fl);
				/* } */ case 8:
				_r = makeValue(typ[0], wrapJsObject(typ[0], a[0][i[0]]), fl); /* */ $s = 9; case 9: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
				$24r = _r;
				$s = 10; case 10: return $24r;
			/* } else if (_1 === (23)) { */ case 3:
				s = $clone(v, Value).object();
				if (i[0] < 0 || i[0] >= ($parseInt(s.$length) >> 0)) {
					$panic(new $String("reflect: slice index out of range"));
				}
				tt$1 = (v.typ.kindType);
				typ$1[0] = tt$1.elem;
				fl$1 = (((384 | new flag(v.flag).ro()) >>> 0) | ((typ$1[0].Kind() >>> 0))) >>> 0;
				i[0] = i[0] + (($parseInt(s.$offset) >> 0)) >> 0;
				a$1[0] = s.$array;
				/* */ if (!((((fl$1 & 128) >>> 0) === 0)) && !((typ$1[0].Kind() === 17)) && !((typ$1[0].Kind() === 25))) { $s = 11; continue; }
				/* */ $s = 12; continue;
				/* if (!((((fl$1 & 128) >>> 0) === 0)) && !((typ$1[0].Kind() === 17)) && !((typ$1[0].Kind() === 25))) { */ case 11:
					$s = -1; return new Value.ptr(typ$1[0], (new (jsType(PtrTo(typ$1[0])))((function(a, a$1, c, i, typ, typ$1) { return function() {
						return wrapJsObject(typ$1[0], a$1[0][i[0]]);
					}; })(a, a$1, c, i, typ, typ$1), (function(a, a$1, c, i, typ, typ$1) { return function(x) {
						var x;
						a$1[0][i[0]] = unwrapJsObject(typ$1[0], x);
					}; })(a, a$1, c, i, typ, typ$1))), fl$1);
				/* } */ case 12:
				_r$1 = makeValue(typ$1[0], wrapJsObject(typ$1[0], a$1[0][i[0]]), fl$1); /* */ $s = 13; case 13: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
				$24r$1 = _r$1;
				$s = 14; case 14: return $24r$1;
			/* } else if (_1 === (24)) { */ case 4:
				str = (v.ptr).$get();
				if (i[0] < 0 || i[0] >= str.length) {
					$panic(new $String("reflect: string index out of range"));
				}
				fl$2 = (((new flag(v.flag).ro() | 8) >>> 0) | 128) >>> 0;
				c[0] = str.charCodeAt(i[0]);
				$s = -1; return new Value.ptr(uint8Type, ((c.$ptr || (c.$ptr = new ptrType$14(function() { return this.$target[0]; }, function($v) { this.$target[0] = $v; }, c)))), fl$2);
			/* } else { */ case 5:
				$panic(new ValueError.ptr("reflect.Value.Index", k));
			/* } */ case 6:
		case 1:
		$s = -1; return new Value.ptr(ptrType$1.nil, 0, 0);
		/* */ } return; } var $f = {$blk: Value.ptr.prototype.Index, $c: true, $r, $24r, $24r$1, _1, _r, _r$1, a, a$1, c, fl, fl$1, fl$2, i, k, s, str, tt, tt$1, typ, typ$1, v, $s};return $f;
	};
	Value.prototype.Index = function(i) { return this.$val.Index(i); };
	Value.ptr.prototype.InterfaceData = function() {
		var v;
		v = this;
		$panic(errors.New("InterfaceData is not supported by GopherJS"));
	};
	Value.prototype.InterfaceData = function() { return this.$val.InterfaceData(); };
	Value.ptr.prototype.IsNil = function() {
		var _1, k, v;
		v = this;
		k = new flag(v.flag).kind();
		_1 = k;
		if ((_1 === (22)) || (_1 === (23))) {
			return $clone(v, Value).object() === jsType(v.typ).nil;
		} else if (_1 === (18)) {
			return $clone(v, Value).object() === $chanNil;
		} else if (_1 === (19)) {
			return $clone(v, Value).object() === $throwNilPointerError;
		} else if (_1 === (21)) {
			return $clone(v, Value).object() === false;
		} else if (_1 === (20)) {
			return $clone(v, Value).object() === $ifaceNil;
		} else if (_1 === (26)) {
			return $clone(v, Value).object() === 0;
		} else {
			$panic(new ValueError.ptr("reflect.Value.IsNil", k));
		}
	};
	Value.prototype.IsNil = function() { return this.$val.IsNil(); };
	Value.ptr.prototype.Len = function() {
		var {$24r, _1, _r, _r$1, k, v, $s, $r, $c} = $restore(this, {});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		v = this;
			k = new flag(v.flag).kind();
			_1 = k;
			/* */ if ((_1 === (17)) || (_1 === (24))) { $s = 2; continue; }
			/* */ if (_1 === (23)) { $s = 3; continue; }
			/* */ if (_1 === (18)) { $s = 4; continue; }
			/* */ if (_1 === (21)) { $s = 5; continue; }
			/* */ if (_1 === (22)) { $s = 6; continue; }
			/* */ $s = 7; continue;
			/* if ((_1 === (17)) || (_1 === (24))) { */ case 2:
				$s = -1; return $parseInt($clone(v, Value).object().length);
			/* } else if (_1 === (23)) { */ case 3:
				$s = -1; return $parseInt($clone(v, Value).object().$length) >> 0;
			/* } else if (_1 === (18)) { */ case 4:
				$s = -1; return $parseInt($clone(v, Value).object().$buffer.length) >> 0;
			/* } else if (_1 === (21)) { */ case 5:
				$s = -1; return $parseInt($clone(v, Value).object().size) >> 0;
			/* } else if (_1 === (22)) { */ case 6:
				_r = v.typ.Elem().Kind(); /* */ $s = 11; case 11: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
				/* */ if (_r === 17) { $s = 9; continue; }
				/* */ $s = 10; continue;
				/* if (_r === 17) { */ case 9:
					_r$1 = v.typ.Elem().Len(); /* */ $s = 12; case 12: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
					$24r = _r$1;
					$s = 13; case 13: return $24r;
				/* } */ case 10:
				$panic(new $String("reflect: call of reflect.Value.Len on ptr to non-array Value"));
				$s = 8; continue;
			/* } else { */ case 7:
				$panic(new ValueError.ptr("reflect.Value.Len", k));
			/* } */ case 8:
		case 1:
		$s = -1; return 0;
		/* */ } return; } var $f = {$blk: Value.ptr.prototype.Len, $c: true, $r, $24r, _1, _r, _r$1, k, v, $s};return $f;
	};
	Value.prototype.Len = function() { return this.$val.Len(); };
	Value.ptr.prototype.Pointer = function() {
		var _1, k, v;
		v = this;
		k = new flag(v.flag).kind();
		_1 = k;
		if ((_1 === (18)) || (_1 === (21)) || (_1 === (22)) || (_1 === (26))) {
			if ($clone(v, Value).IsNil()) {
				return 0;
			}
			return $clone(v, Value).object();
		} else if (_1 === (19)) {
			if ($clone(v, Value).IsNil()) {
				return 0;
			}
			return 1;
		} else if (_1 === (23)) {
			if ($clone(v, Value).IsNil()) {
				return 0;
			}
			return $clone(v, Value).object().$array;
		} else {
			$panic(new ValueError.ptr("reflect.Value.Pointer", k));
		}
	};
	Value.prototype.Pointer = function() { return this.$val.Pointer(); };
	Value.ptr.prototype.Set = function(x) {
		var {_1, _r, _r$1, v, x, $s, $r, $c} = $restore(this, {x});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		v = this;
		new flag(v.flag).mustBeAssignable();
		new flag(x.flag).mustBeExported();
		_r = $clone(x, Value).assignTo("reflect.Set", v.typ, 0); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		x = _r;
		/* */ if (!((((v.flag & 128) >>> 0) === 0))) { $s = 2; continue; }
		/* */ $s = 3; continue;
		/* if (!((((v.flag & 128) >>> 0) === 0))) { */ case 2:
				_1 = v.typ.Kind();
				/* */ if ((_1 === (17)) || (_1 === (25))) { $s = 5; continue; }
				/* */ if (_1 === (20)) { $s = 6; continue; }
				/* */ $s = 7; continue;
				/* if ((_1 === (17)) || (_1 === (25))) { */ case 5:
					jsType(v.typ).copy(v.ptr, x.ptr);
					$s = 8; continue;
				/* } else if (_1 === (20)) { */ case 6:
					_r$1 = valueInterface($clone(x, Value), false); /* */ $s = 9; case 9: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
					v.ptr.$set(_r$1);
					$s = 8; continue;
				/* } else { */ case 7:
					v.ptr.$set($clone(x, Value).object());
				/* } */ case 8:
			case 4:
			$s = -1; return;
		/* } */ case 3:
		v.ptr = x.ptr;
		$s = -1; return;
		/* */ } return; } var $f = {$blk: Value.ptr.prototype.Set, $c: true, $r, _1, _r, _r$1, v, x, $s};return $f;
	};
	Value.prototype.Set = function(x) { return this.$val.Set(x); };
	Value.ptr.prototype.bytesSlow = function() {
		var {_1, _r, _r$1, v, $s, $r, $c} = $restore(this, {});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		v = this;
			_1 = new flag(v.flag).kind();
			/* */ if (_1 === (23)) { $s = 2; continue; }
			/* */ if (_1 === (17)) { $s = 3; continue; }
			/* */ $s = 4; continue;
			/* if (_1 === (23)) { */ case 2:
				_r = v.typ.Elem().Kind(); /* */ $s = 7; case 7: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
				/* */ if (!((_r === 8))) { $s = 5; continue; }
				/* */ $s = 6; continue;
				/* if (!((_r === 8))) { */ case 5:
					$panic(new $String("reflect.Value.Bytes of non-byte slice"));
				/* } */ case 6:
				$s = -1; return (v.ptr).$get();
			/* } else if (_1 === (17)) { */ case 3:
				_r$1 = v.typ.Elem().Kind(); /* */ $s = 10; case 10: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
				/* */ if (!((_r$1 === 8))) { $s = 8; continue; }
				/* */ $s = 9; continue;
				/* if (!((_r$1 === 8))) { */ case 8:
					$panic(new $String("reflect.Value.Bytes of non-byte array"));
				/* } */ case 9:
				if (!$clone(v, Value).CanAddr()) {
					$panic(new $String("reflect.Value.Bytes of unaddressable byte array"));
				}
				$s = -1; return $assertType($internalize(v.ptr, $emptyInterface), sliceType$4);
			/* } */ case 4:
		case 1:
		$panic(new ValueError.ptr("reflect.Value.Bytes", new flag(v.flag).kind()));
		$s = -1; return sliceType$4.nil;
		/* */ } return; } var $f = {$blk: Value.ptr.prototype.bytesSlow, $c: true, $r, _1, _r, _r$1, v, $s};return $f;
	};
	Value.prototype.bytesSlow = function() { return this.$val.bytesSlow(); };
	Value.ptr.prototype.SetBytes = function(x) {
		var {_r, _r$1, _v, slice, typedSlice, v, x, $s, $r, $c} = $restore(this, {x});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		v = this;
		new flag(v.flag).mustBeAssignable();
		new flag(v.flag).mustBe(23);
		_r = v.typ.Elem().Kind(); /* */ $s = 3; case 3: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		/* */ if (!((_r === 8))) { $s = 1; continue; }
		/* */ $s = 2; continue;
		/* if (!((_r === 8))) { */ case 1:
			$panic(new $String("reflect.Value.SetBytes of non-byte slice"));
		/* } */ case 2:
		slice = x;
		if (!(v.typ.Name() === "")) { _v = true; $s = 6; continue s; }
		_r$1 = v.typ.Elem().Name(); /* */ $s = 7; case 7: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
		_v = !(_r$1 === ""); case 6:
		/* */ if (_v) { $s = 4; continue; }
		/* */ $s = 5; continue;
		/* if (_v) { */ case 4:
			typedSlice = new (jsType(v.typ))(slice.$array);
			typedSlice.$offset = slice.$offset;
			typedSlice.$length = slice.$length;
			typedSlice.$capacity = slice.$capacity;
			slice = typedSlice;
		/* } */ case 5:
		v.ptr.$set(slice);
		$s = -1; return;
		/* */ } return; } var $f = {$blk: Value.ptr.prototype.SetBytes, $c: true, $r, _r, _r$1, _v, slice, typedSlice, v, x, $s};return $f;
	};
	Value.prototype.SetBytes = function(x) { return this.$val.SetBytes(x); };
	Value.ptr.prototype.SetCap = function(n) {
		var n, newSlice, s, v;
		v = this;
		new flag(v.flag).mustBeAssignable();
		new flag(v.flag).mustBe(23);
		s = v.ptr.$get();
		if (n < ($parseInt(s.$length) >> 0) || n > ($parseInt(s.$capacity) >> 0)) {
			$panic(new $String("reflect: slice capacity out of range in SetCap"));
		}
		newSlice = new (jsType(v.typ))(s.$array);
		newSlice.$offset = s.$offset;
		newSlice.$length = s.$length;
		newSlice.$capacity = n;
		v.ptr.$set(newSlice);
	};
	Value.prototype.SetCap = function(n) { return this.$val.SetCap(n); };
	Value.ptr.prototype.SetLen = function(n) {
		var n, newSlice, s, v;
		v = this;
		new flag(v.flag).mustBeAssignable();
		new flag(v.flag).mustBe(23);
		s = v.ptr.$get();
		if (n < 0 || n > ($parseInt(s.$capacity) >> 0)) {
			$panic(new $String("reflect: slice length out of range in SetLen"));
		}
		newSlice = new (jsType(v.typ))(s.$array);
		newSlice.$offset = s.$offset;
		newSlice.$length = n;
		newSlice.$capacity = s.$capacity;
		v.ptr.$set(newSlice);
	};
	Value.prototype.SetLen = function(n) { return this.$val.SetLen(n); };
	Value.ptr.prototype.Slice = function(i, j) {
		var {$24r, $24r$1, _1, _r, _r$1, cap, i, j, kind, s, str, tt, typ, v, $s, $r, $c} = $restore(this, {i, j});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		v = this;
		cap = 0;
		typ = $ifaceNil;
		s = null;
			kind = new flag(v.flag).kind();
			_1 = kind;
			/* */ if (_1 === (17)) { $s = 2; continue; }
			/* */ if (_1 === (23)) { $s = 3; continue; }
			/* */ if (_1 === (24)) { $s = 4; continue; }
			/* */ $s = 5; continue;
			/* if (_1 === (17)) { */ case 2:
				if (((v.flag & 256) >>> 0) === 0) {
					$panic(new $String("reflect.Value.Slice: slice of unaddressable array"));
				}
				tt = (v.typ.kindType);
				cap = ((tt.len >> 0));
				typ = SliceOf(tt.elem);
				s = new (jsType(typ))($clone(v, Value).object());
				$s = 6; continue;
			/* } else if (_1 === (23)) { */ case 3:
				typ = v.typ;
				s = $clone(v, Value).object();
				cap = $parseInt(s.$capacity) >> 0;
				$s = 6; continue;
			/* } else if (_1 === (24)) { */ case 4:
				str = (v.ptr).$get();
				if (i < 0 || j < i || j > str.length) {
					$panic(new $String("reflect.Value.Slice: string slice index out of bounds"));
				}
				_r = ValueOf(new $String($substring(str, i, j))); /* */ $s = 7; case 7: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
				$24r = _r;
				$s = 8; case 8: return $24r;
			/* } else { */ case 5:
				$panic(new ValueError.ptr("reflect.Value.Slice", kind));
			/* } */ case 6:
		case 1:
		if (i < 0 || j < i || j > cap) {
			$panic(new $String("reflect.Value.Slice: slice index out of bounds"));
		}
		_r$1 = makeValue(typ, $subslice(s, i, j), new flag(v.flag).ro()); /* */ $s = 9; case 9: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
		$24r$1 = _r$1;
		$s = 10; case 10: return $24r$1;
		/* */ } return; } var $f = {$blk: Value.ptr.prototype.Slice, $c: true, $r, $24r, $24r$1, _1, _r, _r$1, cap, i, j, kind, s, str, tt, typ, v, $s};return $f;
	};
	Value.prototype.Slice = function(i, j) { return this.$val.Slice(i, j); };
	Value.ptr.prototype.Slice3 = function(i, j, k) {
		var {$24r, _1, _r, cap, i, j, k, kind, s, tt, typ, v, $s, $r, $c} = $restore(this, {i, j, k});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		v = this;
		cap = 0;
		typ = $ifaceNil;
		s = null;
		kind = new flag(v.flag).kind();
		_1 = kind;
		if (_1 === (17)) {
			if (((v.flag & 256) >>> 0) === 0) {
				$panic(new $String("reflect.Value.Slice: slice of unaddressable array"));
			}
			tt = (v.typ.kindType);
			cap = ((tt.len >> 0));
			typ = SliceOf(tt.elem);
			s = new (jsType(typ))($clone(v, Value).object());
		} else if (_1 === (23)) {
			typ = v.typ;
			s = $clone(v, Value).object();
			cap = $parseInt(s.$capacity) >> 0;
		} else {
			$panic(new ValueError.ptr("reflect.Value.Slice3", kind));
		}
		if (i < 0 || j < i || k < j || k > cap) {
			$panic(new $String("reflect.Value.Slice3: slice index out of bounds"));
		}
		_r = makeValue(typ, $subslice(s, i, j, k), new flag(v.flag).ro()); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		$24r = _r;
		$s = 2; case 2: return $24r;
		/* */ } return; } var $f = {$blk: Value.ptr.prototype.Slice3, $c: true, $r, $24r, _1, _r, cap, i, j, k, kind, s, tt, typ, v, $s};return $f;
	};
	Value.prototype.Slice3 = function(i, j, k) { return this.$val.Slice3(i, j, k); };
	Value.ptr.prototype.Close = function() {
		var v;
		v = this;
		new flag(v.flag).mustBe(18);
		new flag(v.flag).mustBeExported();
		$close($clone(v, Value).object());
	};
	Value.prototype.Close = function() { return this.$val.Close(); };
	chanrecv = function(ch, nb, val) {
		var {_r, _tmp, _tmp$1, _tmp$2, _tmp$3, ch, comms, nb, received, recvRes, selectRes, selected, val, $s, $r, $c} = $restore(this, {ch, nb, val});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		selected = false;
		received = false;
		comms = new sliceType$18([new sliceType$16([ch])]);
		if (nb) {
			comms = $append(comms, new sliceType$16([]));
		}
		_r = selectHelper(new sliceType$5([comms])); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		selectRes = _r;
		if (nb && (($parseInt(selectRes[0]) >> 0) === 1)) {
			_tmp = false;
			_tmp$1 = false;
			selected = _tmp;
			received = _tmp$1;
			$s = -1; return [selected, received];
		}
		recvRes = selectRes[1];
		val.$set(recvRes[0]);
		_tmp$2 = true;
		_tmp$3 = !!(recvRes[1]);
		selected = _tmp$2;
		received = _tmp$3;
		$s = -1; return [selected, received];
		/* */ } return; } var $f = {$blk: chanrecv, $c: true, $r, _r, _tmp, _tmp$1, _tmp$2, _tmp$3, ch, comms, nb, received, recvRes, selectRes, selected, val, $s};return $f;
	};
	chansend = function(ch, val, nb) {
		var {_r, ch, comms, nb, selectRes, val, $s, $r, $c} = $restore(this, {ch, val, nb});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		comms = new sliceType$18([new sliceType$16([ch, val.$get()])]);
		if (nb) {
			comms = $append(comms, new sliceType$16([]));
		}
		_r = selectHelper(new sliceType$5([comms])); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		selectRes = _r;
		if (nb && (($parseInt(selectRes[0]) >> 0) === 1)) {
			$s = -1; return false;
		}
		$s = -1; return true;
		/* */ } return; } var $f = {$blk: chansend, $c: true, $r, _r, ch, comms, nb, selectRes, val, $s};return $f;
	};
	stringsLastIndex = function(s, c) {
		var c, i, s;
		i = s.length - 1 >> 0;
		while (true) {
			if (!(i >= 0)) { break; }
			if (s.charCodeAt(i) === c) {
				return i;
			}
			i = i - (1) >> 0;
		}
		return -1;
	};
	stringsHasPrefix = function(s, prefix) {
		var prefix, s;
		return s.length >= prefix.length && $substring(s, 0, prefix.length) === prefix;
	};
	valueMethodName = function() {
		var _tuple, frame, frames, idx, methodName, more, n, name$1, pc;
		pc = arrayType$7.zero();
		n = runtime.Callers(1, new sliceType$20(pc));
		frames = runtime.CallersFrames($subslice(new sliceType$20(pc), 0, n));
		frame = new runtime.Frame.ptr(0, ptrType$6.nil, "", "", 0, 0);
		more = true;
		while (true) {
			if (!(more)) { break; }
			_tuple = frames.Next();
			runtime.Frame.copy(frame, _tuple[0]);
			more = _tuple[1];
			name$1 = frame.Function;
			if (stringsHasPrefix(name$1, "Object.$packages.reflect.")) {
				idx = stringsLastIndex(name$1, 46);
				if (idx >= 0) {
					methodName = $substring(name$1, (idx + 1 >> 0));
					if (methodName.length > 0 && 65 <= methodName.charCodeAt(0) && methodName.charCodeAt(0) <= 90) {
						return "reflect.Value." + methodName;
					}
				}
			}
		}
		return "unknown method";
	};
	verifyNotInHeapPtr = function(p) {
		var p;
		return true;
	};
	Value.methods = [{prop: "pointer", name: "pointer", pkg: "reflect", typ: $funcType([], [$UnsafePointer], false)}, {prop: "Addr", name: "Addr", pkg: "", typ: $funcType([], [Value], false)}, {prop: "Bool", name: "Bool", pkg: "", typ: $funcType([], [$Bool], false)}, {prop: "panicNotBool", name: "panicNotBool", pkg: "reflect", typ: $funcType([], [], false)}, {prop: "Bytes", name: "Bytes", pkg: "", typ: $funcType([], [sliceType$4], false)}, {prop: "runes", name: "runes", pkg: "reflect", typ: $funcType([], [sliceType$10], false)}, {prop: "CanAddr", name: "CanAddr", pkg: "", typ: $funcType([], [$Bool], false)}, {prop: "CanSet", name: "CanSet", pkg: "", typ: $funcType([], [$Bool], false)}, {prop: "Call", name: "Call", pkg: "", typ: $funcType([sliceType$8], [sliceType$8], false)}, {prop: "CallSlice", name: "CallSlice", pkg: "", typ: $funcType([sliceType$8], [sliceType$8], false)}, {prop: "capNonSlice", name: "capNonSlice", pkg: "reflect", typ: $funcType([], [$Int], false)}, {prop: "CanComplex", name: "CanComplex", pkg: "", typ: $funcType([], [$Bool], false)}, {prop: "Complex", name: "Complex", pkg: "", typ: $funcType([], [$Complex128], false)}, {prop: "FieldByIndex", name: "FieldByIndex", pkg: "", typ: $funcType([sliceType$7], [Value], false)}, {prop: "FieldByIndexErr", name: "FieldByIndexErr", pkg: "", typ: $funcType([sliceType$7], [Value, $error], false)}, {prop: "FieldByName", name: "FieldByName", pkg: "", typ: $funcType([$String], [Value], false)}, {prop: "FieldByNameFunc", name: "FieldByNameFunc", pkg: "", typ: $funcType([funcType$3], [Value], false)}, {prop: "CanFloat", name: "CanFloat", pkg: "", typ: $funcType([], [$Bool], false)}, {prop: "Float", name: "Float", pkg: "", typ: $funcType([], [$Float64], false)}, {prop: "CanInt", name: "CanInt", pkg: "", typ: $funcType([], [$Bool], false)}, {prop: "Int", name: "Int", pkg: "", typ: $funcType([], [$Int64], false)}, {prop: "CanInterface", name: "CanInterface", pkg: "", typ: $funcType([], [$Bool], false)}, {prop: "Interface", name: "Interface", pkg: "", typ: $funcType([], [$emptyInterface], false)}, {prop: "IsValid", name: "IsValid", pkg: "", typ: $funcType([], [$Bool], false)}, {prop: "IsZero", name: "IsZero", pkg: "", typ: $funcType([], [$Bool], false)}, {prop: "Kind", name: "Kind", pkg: "", typ: $funcType([], [Kind], false)}, {prop: "lenNonSlice", name: "lenNonSlice", pkg: "reflect", typ: $funcType([], [$Int], false)}, {prop: "MapIndex", name: "MapIndex", pkg: "", typ: $funcType([Value], [Value], false)}, {prop: "MapKeys", name: "MapKeys", pkg: "", typ: $funcType([], [sliceType$8], false)}, {prop: "SetIterKey", name: "SetIterKey", pkg: "", typ: $funcType([ptrType$23], [], false)}, {prop: "SetIterValue", name: "SetIterValue", pkg: "", typ: $funcType([ptrType$23], [], false)}, {prop: "MapRange", name: "MapRange", pkg: "", typ: $funcType([], [ptrType$23], false)}, {prop: "Method", name: "Method", pkg: "", typ: $funcType([$Int], [Value], false)}, {prop: "NumMethod", name: "NumMethod", pkg: "", typ: $funcType([], [$Int], false)}, {prop: "MethodByName", name: "MethodByName", pkg: "", typ: $funcType([$String], [Value], false)}, {prop: "NumField", name: "NumField", pkg: "", typ: $funcType([], [$Int], false)}, {prop: "OverflowComplex", name: "OverflowComplex", pkg: "", typ: $funcType([$Complex128], [$Bool], false)}, {prop: "OverflowFloat", name: "OverflowFloat", pkg: "", typ: $funcType([$Float64], [$Bool], false)}, {prop: "OverflowInt", name: "OverflowInt", pkg: "", typ: $funcType([$Int64], [$Bool], false)}, {prop: "OverflowUint", name: "OverflowUint", pkg: "", typ: $funcType([$Uint64], [$Bool], false)}, {prop: "Recv", name: "Recv", pkg: "", typ: $funcType([], [Value, $Bool], false)}, {prop: "recv", name: "recv", pkg: "reflect", typ: $funcType([$Bool], [Value, $Bool], false)}, {prop: "Send", name: "Send", pkg: "", typ: $funcType([Value], [], false)}, {prop: "send", name: "send", pkg: "reflect", typ: $funcType([Value, $Bool], [$Bool], false)}, {prop: "SetBool", name: "SetBool", pkg: "", typ: $funcType([$Bool], [], false)}, {prop: "setRunes", name: "setRunes", pkg: "reflect", typ: $funcType([sliceType$10], [], false)}, {prop: "SetComplex", name: "SetComplex", pkg: "", typ: $funcType([$Complex128], [], false)}, {prop: "SetFloat", name: "SetFloat", pkg: "", typ: $funcType([$Float64], [], false)}, {prop: "SetInt", name: "SetInt", pkg: "", typ: $funcType([$Int64], [], false)}, {prop: "SetMapIndex", name: "SetMapIndex", pkg: "", typ: $funcType([Value, Value], [], false)}, {prop: "SetUint", name: "SetUint", pkg: "", typ: $funcType([$Uint64], [], false)}, {prop: "SetPointer", name: "SetPointer", pkg: "", typ: $funcType([$UnsafePointer], [], false)}, {prop: "SetString", name: "SetString", pkg: "", typ: $funcType([$String], [], false)}, {prop: "String", name: "String", pkg: "", typ: $funcType([], [$String], false)}, {prop: "stringNonString", name: "stringNonString", pkg: "reflect", typ: $funcType([], [$String], false)}, {prop: "TryRecv", name: "TryRecv", pkg: "", typ: $funcType([], [Value, $Bool], false)}, {prop: "TrySend", name: "TrySend", pkg: "", typ: $funcType([Value], [$Bool], false)}, {prop: "Type", name: "Type", pkg: "", typ: $funcType([], [Type], false)}, {prop: "typeSlow", name: "typeSlow", pkg: "reflect", typ: $funcType([], [Type], false)}, {prop: "CanUint", name: "CanUint", pkg: "", typ: $funcType([], [$Bool], false)}, {prop: "Uint", name: "Uint", pkg: "", typ: $funcType([], [$Uint64], false)}, {prop: "UnsafeAddr", name: "UnsafeAddr", pkg: "", typ: $funcType([], [$Uintptr], false)}, {prop: "UnsafePointer", name: "UnsafePointer", pkg: "", typ: $funcType([], [$UnsafePointer], false)}, {prop: "Convert", name: "Convert", pkg: "", typ: $funcType([Type], [Value], false)}, {prop: "CanConvert", name: "CanConvert", pkg: "", typ: $funcType([Type], [$Bool], false)}, {prop: "object", name: "object", pkg: "reflect", typ: $funcType([], [ptrType$2], false)}, {prop: "assignTo", name: "assignTo", pkg: "reflect", typ: $funcType([$String, ptrType$1, $UnsafePointer], [Value], false)}, {prop: "call", name: "call", pkg: "reflect", typ: $funcType([$String, sliceType$8], [sliceType$8], false)}, {prop: "Cap", name: "Cap", pkg: "", typ: $funcType([], [$Int], false)}, {prop: "Elem", name: "Elem", pkg: "", typ: $funcType([], [Value], false)}, {prop: "Field", name: "Field", pkg: "", typ: $funcType([$Int], [Value], false)}, {prop: "Index", name: "Index", pkg: "", typ: $funcType([$Int], [Value], false)}, {prop: "InterfaceData", name: "InterfaceData", pkg: "", typ: $funcType([], [arrayType$8], false)}, {prop: "IsNil", name: "IsNil", pkg: "", typ: $funcType([], [$Bool], false)}, {prop: "Len", name: "Len", pkg: "", typ: $funcType([], [$Int], false)}, {prop: "Pointer", name: "Pointer", pkg: "", typ: $funcType([], [$Uintptr], false)}, {prop: "Set", name: "Set", pkg: "", typ: $funcType([Value], [], false)}, {prop: "bytesSlow", name: "bytesSlow", pkg: "reflect", typ: $funcType([], [sliceType$4], false)}, {prop: "SetBytes", name: "SetBytes", pkg: "", typ: $funcType([sliceType$4], [], false)}, {prop: "SetCap", name: "SetCap", pkg: "", typ: $funcType([$Int], [], false)}, {prop: "SetLen", name: "SetLen", pkg: "", typ: $funcType([$Int], [], false)}, {prop: "Slice", name: "Slice", pkg: "", typ: $funcType([$Int, $Int], [Value], false)}, {prop: "Slice3", name: "Slice3", pkg: "", typ: $funcType([$Int, $Int, $Int], [Value], false)}, {prop: "Close", name: "Close", pkg: "", typ: $funcType([], [], false)}];
	flag.methods = [{prop: "kind", name: "kind", pkg: "reflect", typ: $funcType([], [Kind], false)}, {prop: "ro", name: "ro", pkg: "reflect", typ: $funcType([], [flag], false)}, {prop: "mustBe", name: "mustBe", pkg: "reflect", typ: $funcType([Kind], [], false)}, {prop: "mustBeExported", name: "mustBeExported", pkg: "reflect", typ: $funcType([], [], false)}, {prop: "mustBeExportedSlow", name: "mustBeExportedSlow", pkg: "reflect", typ: $funcType([], [], false)}, {prop: "mustBeAssignable", name: "mustBeAssignable", pkg: "reflect", typ: $funcType([], [], false)}, {prop: "mustBeAssignableSlow", name: "mustBeAssignableSlow", pkg: "reflect", typ: $funcType([], [], false)}, {prop: "panicNotMap", name: "panicNotMap", pkg: "reflect", typ: $funcType([], [], false)}];
	ptrType$24.methods = [{prop: "Error", name: "Error", pkg: "", typ: $funcType([], [$String], false)}];
	ptrType$23.methods = [{prop: "Key", name: "Key", pkg: "", typ: $funcType([], [Value], false)}, {prop: "Value", name: "Value", pkg: "", typ: $funcType([], [Value], false)}, {prop: "Next", name: "Next", pkg: "", typ: $funcType([], [$Bool], false)}, {prop: "Reset", name: "Reset", pkg: "", typ: $funcType([Value], [], false)}];
	Kind.methods = [{prop: "String", name: "String", pkg: "", typ: $funcType([], [$String], false)}];
	ptrType$1.methods = [{prop: "textOff", name: "textOff", pkg: "reflect", typ: $funcType([textOff], [$UnsafePointer], false)}, {prop: "String", name: "String", pkg: "", typ: $funcType([], [$String], false)}, {prop: "Size", name: "Size", pkg: "", typ: $funcType([], [$Uintptr], false)}, {prop: "Bits", name: "Bits", pkg: "", typ: $funcType([], [$Int], false)}, {prop: "Align", name: "Align", pkg: "", typ: $funcType([], [$Int], false)}, {prop: "FieldAlign", name: "FieldAlign", pkg: "", typ: $funcType([], [$Int], false)}, {prop: "Kind", name: "Kind", pkg: "", typ: $funcType([], [Kind], false)}, {prop: "common", name: "common", pkg: "reflect", typ: $funcType([], [ptrType$1], false)}, {prop: "exportedMethods", name: "exportedMethods", pkg: "reflect", typ: $funcType([], [sliceType$11], false)}, {prop: "NumMethod", name: "NumMethod", pkg: "", typ: $funcType([], [$Int], false)}, {prop: "MethodByName", name: "MethodByName", pkg: "", typ: $funcType([$String], [Method, $Bool], false)}, {prop: "PkgPath", name: "PkgPath", pkg: "", typ: $funcType([], [$String], false)}, {prop: "hasName", name: "hasName", pkg: "reflect", typ: $funcType([], [$Bool], false)}, {prop: "Name", name: "Name", pkg: "", typ: $funcType([], [$String], false)}, {prop: "ChanDir", name: "ChanDir", pkg: "", typ: $funcType([], [ChanDir], false)}, {prop: "IsVariadic", name: "IsVariadic", pkg: "", typ: $funcType([], [$Bool], false)}, {prop: "Elem", name: "Elem", pkg: "", typ: $funcType([], [Type], false)}, {prop: "Field", name: "Field", pkg: "", typ: $funcType([$Int], [StructField], false)}, {prop: "FieldByIndex", name: "FieldByIndex", pkg: "", typ: $funcType([sliceType$7], [StructField], false)}, {prop: "FieldByName", name: "FieldByName", pkg: "", typ: $funcType([$String], [StructField, $Bool], false)}, {prop: "FieldByNameFunc", name: "FieldByNameFunc", pkg: "", typ: $funcType([funcType$3], [StructField, $Bool], false)}, {prop: "In", name: "In", pkg: "", typ: $funcType([$Int], [Type], false)}, {prop: "Key", name: "Key", pkg: "", typ: $funcType([], [Type], false)}, {prop: "Len", name: "Len", pkg: "", typ: $funcType([], [$Int], false)}, {prop: "NumField", name: "NumField", pkg: "", typ: $funcType([], [$Int], false)}, {prop: "NumIn", name: "NumIn", pkg: "", typ: $funcType([], [$Int], false)}, {prop: "NumOut", name: "NumOut", pkg: "", typ: $funcType([], [$Int], false)}, {prop: "Out", name: "Out", pkg: "", typ: $funcType([$Int], [Type], false)}, {prop: "Implements", name: "Implements", pkg: "", typ: $funcType([Type], [$Bool], false)}, {prop: "AssignableTo", name: "AssignableTo", pkg: "", typ: $funcType([Type], [$Bool], false)}, {prop: "ConvertibleTo", name: "ConvertibleTo", pkg: "", typ: $funcType([Type], [$Bool], false)}, {prop: "gcSlice", name: "gcSlice", pkg: "reflect", typ: $funcType([$Uintptr, $Uintptr], [sliceType$4], false)}, {prop: "uncommon", name: "uncommon", pkg: "reflect", typ: $funcType([], [ptrType$10], false)}, {prop: "nameOff", name: "nameOff", pkg: "reflect", typ: $funcType([nameOff], [name], false)}, {prop: "typeOff", name: "typeOff", pkg: "reflect", typ: $funcType([typeOff], [ptrType$1], false)}, {prop: "ptrTo", name: "ptrTo", pkg: "reflect", typ: $funcType([], [ptrType$1], false)}, {prop: "pointers", name: "pointers", pkg: "reflect", typ: $funcType([], [$Bool], false)}, {prop: "Comparable", name: "Comparable", pkg: "", typ: $funcType([], [$Bool], false)}, {prop: "Method", name: "Method", pkg: "", typ: $funcType([$Int], [Method], false)}];
	ChanDir.methods = [{prop: "String", name: "String", pkg: "", typ: $funcType([], [$String], false)}];
	ptrType$11.methods = [{prop: "Method", name: "Method", pkg: "", typ: $funcType([$Int], [Method], false)}, {prop: "NumMethod", name: "NumMethod", pkg: "", typ: $funcType([], [$Int], false)}, {prop: "MethodByName", name: "MethodByName", pkg: "", typ: $funcType([$String], [Method, $Bool], false)}];
	ptrType$26.methods = [{prop: "embedded", name: "embedded", pkg: "reflect", typ: $funcType([], [$Bool], false)}];
	ptrType$13.methods = [{prop: "Field", name: "Field", pkg: "", typ: $funcType([$Int], [StructField], false)}, {prop: "FieldByIndex", name: "FieldByIndex", pkg: "", typ: $funcType([sliceType$7], [StructField], false)}, {prop: "FieldByNameFunc", name: "FieldByNameFunc", pkg: "", typ: $funcType([funcType$3], [StructField, $Bool], false)}, {prop: "FieldByName", name: "FieldByName", pkg: "", typ: $funcType([$String], [StructField, $Bool], false)}];
	Method.methods = [{prop: "IsExported", name: "IsExported", pkg: "", typ: $funcType([], [$Bool], false)}];
	StructField.methods = [{prop: "IsExported", name: "IsExported", pkg: "", typ: $funcType([], [$Bool], false)}];
	StructTag.methods = [{prop: "Get", name: "Get", pkg: "", typ: $funcType([$String], [$String], false)}, {prop: "Lookup", name: "Lookup", pkg: "", typ: $funcType([$String], [$String, $Bool], false)}];
	ptrType$10.methods = [{prop: "methods", name: "methods", pkg: "reflect", typ: $funcType([], [sliceType$11], false)}, {prop: "exportedMethods", name: "exportedMethods", pkg: "reflect", typ: $funcType([], [sliceType$11], false)}];
	ptrType$20.methods = [{prop: "in$", name: "in", pkg: "reflect", typ: $funcType([], [sliceType$2], false)}, {prop: "out", name: "out", pkg: "reflect", typ: $funcType([], [sliceType$2], false)}];
	name.methods = [{prop: "data", name: "data", pkg: "reflect", typ: $funcType([$Int, $String], [ptrType$14], false)}, {prop: "hasTag", name: "hasTag", pkg: "reflect", typ: $funcType([], [$Bool], false)}, {prop: "readVarint", name: "readVarint", pkg: "reflect", typ: $funcType([$Int], [$Int, $Int], false)}, {prop: "name", name: "name", pkg: "reflect", typ: $funcType([], [$String], false)}, {prop: "tag", name: "tag", pkg: "reflect", typ: $funcType([], [$String], false)}, {prop: "pkgPath", name: "pkgPath", pkg: "reflect", typ: $funcType([], [$String], false)}, {prop: "isExported", name: "isExported", pkg: "reflect", typ: $funcType([], [$Bool], false)}, {prop: "embedded", name: "embedded", pkg: "reflect", typ: $funcType([], [$Bool], false)}, {prop: "setPkgPath", name: "setPkgPath", pkg: "reflect", typ: $funcType([$String], [], false)}];
	ptrType$27.methods = [{prop: "initialized", name: "initialized", pkg: "reflect", typ: $funcType([], [$Bool], false)}, {prop: "skipUntilValidKey", name: "skipUntilValidKey", pkg: "reflect", typ: $funcType([], [], false)}];
	Value.init("reflect", [{prop: "typ", name: "typ", embedded: false, exported: false, typ: ptrType$1, tag: ""}, {prop: "ptr", name: "ptr", embedded: false, exported: false, typ: $UnsafePointer, tag: ""}, {prop: "flag", name: "flag", embedded: true, exported: false, typ: flag, tag: ""}]);
	ValueError.init("", [{prop: "Method", name: "Method", embedded: false, exported: true, typ: $String, tag: ""}, {prop: "Kind", name: "Kind", embedded: false, exported: true, typ: Kind, tag: ""}]);
	MapIter.init("reflect", [{prop: "m", name: "m", embedded: false, exported: false, typ: Value, tag: ""}, {prop: "hiter", name: "hiter", embedded: false, exported: false, typ: hiter, tag: ""}]);
	Type.init([{prop: "Align", name: "Align", pkg: "", typ: $funcType([], [$Int], false)}, {prop: "AssignableTo", name: "AssignableTo", pkg: "", typ: $funcType([Type], [$Bool], false)}, {prop: "Bits", name: "Bits", pkg: "", typ: $funcType([], [$Int], false)}, {prop: "ChanDir", name: "ChanDir", pkg: "", typ: $funcType([], [ChanDir], false)}, {prop: "Comparable", name: "Comparable", pkg: "", typ: $funcType([], [$Bool], false)}, {prop: "ConvertibleTo", name: "ConvertibleTo", pkg: "", typ: $funcType([Type], [$Bool], false)}, {prop: "Elem", name: "Elem", pkg: "", typ: $funcType([], [Type], false)}, {prop: "Field", name: "Field", pkg: "", typ: $funcType([$Int], [StructField], false)}, {prop: "FieldAlign", name: "FieldAlign", pkg: "", typ: $funcType([], [$Int], false)}, {prop: "FieldByIndex", name: "FieldByIndex", pkg: "", typ: $funcType([sliceType$7], [StructField], false)}, {prop: "FieldByName", name: "FieldByName", pkg: "", typ: $funcType([$String], [StructField, $Bool], false)}, {prop: "FieldByNameFunc", name: "FieldByNameFunc", pkg: "", typ: $funcType([funcType$3], [StructField, $Bool], false)}, {prop: "Implements", name: "Implements", pkg: "", typ: $funcType([Type], [$Bool], false)}, {prop: "In", name: "In", pkg: "", typ: $funcType([$Int], [Type], false)}, {prop: "IsVariadic", name: "IsVariadic", pkg: "", typ: $funcType([], [$Bool], false)}, {prop: "Key", name: "Key", pkg: "", typ: $funcType([], [Type], false)}, {prop: "Kind", name: "Kind", pkg: "", typ: $funcType([], [Kind], false)}, {prop: "Len", name: "Len", pkg: "", typ: $funcType([], [$Int], false)}, {prop: "Method", name: "Method", pkg: "", typ: $funcType([$Int], [Method], false)}, {prop: "MethodByName", name: "MethodByName", pkg: "", typ: $funcType([$String], [Method, $Bool], false)}, {prop: "Name", name: "Name", pkg: "", typ: $funcType([], [$String], false)}, {prop: "NumField", name: "NumField", pkg: "", typ: $funcType([], [$Int], false)}, {prop: "NumIn", name: "NumIn", pkg: "", typ: $funcType([], [$Int], false)}, {prop: "NumMethod", name: "NumMethod", pkg: "", typ: $funcType([], [$Int], false)}, {prop: "NumOut", name: "NumOut", pkg: "", typ: $funcType([], [$Int], false)}, {prop: "Out", name: "Out", pkg: "", typ: $funcType([$Int], [Type], false)}, {prop: "PkgPath", name: "PkgPath", pkg: "", typ: $funcType([], [$String], false)}, {prop: "Size", name: "Size", pkg: "", typ: $funcType([], [$Uintptr], false)}, {prop: "String", name: "String", pkg: "", typ: $funcType([], [$String], false)}, {prop: "common", name: "common", pkg: "reflect", typ: $funcType([], [ptrType$1], false)}, {prop: "uncommon", name: "uncommon", pkg: "reflect", typ: $funcType([], [ptrType$10], false)}]);
	rtype.init("reflect", [{prop: "size", name: "size", embedded: false, exported: false, typ: $Uintptr, tag: ""}, {prop: "ptrdata", name: "ptrdata", embedded: false, exported: false, typ: $Uintptr, tag: ""}, {prop: "hash", name: "hash", embedded: false, exported: false, typ: $Uint32, tag: ""}, {prop: "tflag", name: "tflag", embedded: false, exported: false, typ: tflag, tag: ""}, {prop: "align", name: "align", embedded: false, exported: false, typ: $Uint8, tag: ""}, {prop: "fieldAlign", name: "fieldAlign", embedded: false, exported: false, typ: $Uint8, tag: ""}, {prop: "kind", name: "kind", embedded: false, exported: false, typ: $Uint8, tag: ""}, {prop: "equal", name: "equal", embedded: false, exported: false, typ: funcType$4, tag: ""}, {prop: "gcdata", name: "gcdata", embedded: false, exported: false, typ: ptrType$14, tag: ""}, {prop: "str", name: "str", embedded: false, exported: false, typ: nameOff, tag: ""}, {prop: "ptrToThis", name: "ptrToThis", embedded: false, exported: false, typ: typeOff, tag: ""}]);
	method.init("reflect", [{prop: "name", name: "name", embedded: false, exported: false, typ: nameOff, tag: ""}, {prop: "mtyp", name: "mtyp", embedded: false, exported: false, typ: typeOff, tag: ""}, {prop: "ifn", name: "ifn", embedded: false, exported: false, typ: textOff, tag: ""}, {prop: "tfn", name: "tfn", embedded: false, exported: false, typ: textOff, tag: ""}]);
	arrayType.init("reflect", [{prop: "rtype", name: "rtype", embedded: true, exported: false, typ: rtype, tag: ""}, {prop: "elem", name: "elem", embedded: false, exported: false, typ: ptrType$1, tag: ""}, {prop: "slice", name: "slice", embedded: false, exported: false, typ: ptrType$1, tag: ""}, {prop: "len", name: "len", embedded: false, exported: false, typ: $Uintptr, tag: ""}]);
	chanType.init("reflect", [{prop: "rtype", name: "rtype", embedded: true, exported: false, typ: rtype, tag: ""}, {prop: "elem", name: "elem", embedded: false, exported: false, typ: ptrType$1, tag: ""}, {prop: "dir", name: "dir", embedded: false, exported: false, typ: $Uintptr, tag: ""}]);
	imethod.init("reflect", [{prop: "name", name: "name", embedded: false, exported: false, typ: nameOff, tag: ""}, {prop: "typ", name: "typ", embedded: false, exported: false, typ: typeOff, tag: ""}]);
	interfaceType.init("reflect", [{prop: "rtype", name: "rtype", embedded: true, exported: false, typ: rtype, tag: ""}, {prop: "pkgPath", name: "pkgPath", embedded: false, exported: false, typ: name, tag: ""}, {prop: "methods", name: "methods", embedded: false, exported: false, typ: sliceType$14, tag: ""}]);
	mapType.init("reflect", [{prop: "rtype", name: "rtype", embedded: true, exported: false, typ: rtype, tag: ""}, {prop: "key", name: "key", embedded: false, exported: false, typ: ptrType$1, tag: ""}, {prop: "elem", name: "elem", embedded: false, exported: false, typ: ptrType$1, tag: ""}, {prop: "bucket", name: "bucket", embedded: false, exported: false, typ: ptrType$1, tag: ""}, {prop: "hasher", name: "hasher", embedded: false, exported: false, typ: funcType$5, tag: ""}, {prop: "keysize", name: "keysize", embedded: false, exported: false, typ: $Uint8, tag: ""}, {prop: "valuesize", name: "valuesize", embedded: false, exported: false, typ: $Uint8, tag: ""}, {prop: "bucketsize", name: "bucketsize", embedded: false, exported: false, typ: $Uint16, tag: ""}, {prop: "flags", name: "flags", embedded: false, exported: false, typ: $Uint32, tag: ""}]);
	ptrType.init("reflect", [{prop: "rtype", name: "rtype", embedded: true, exported: false, typ: rtype, tag: ""}, {prop: "elem", name: "elem", embedded: false, exported: false, typ: ptrType$1, tag: ""}]);
	sliceType.init("reflect", [{prop: "rtype", name: "rtype", embedded: true, exported: false, typ: rtype, tag: ""}, {prop: "elem", name: "elem", embedded: false, exported: false, typ: ptrType$1, tag: ""}]);
	structField.init("reflect", [{prop: "name", name: "name", embedded: false, exported: false, typ: name, tag: ""}, {prop: "typ", name: "typ", embedded: false, exported: false, typ: ptrType$1, tag: ""}, {prop: "offset", name: "offset", embedded: false, exported: false, typ: $Uintptr, tag: ""}]);
	structType.init("reflect", [{prop: "rtype", name: "rtype", embedded: true, exported: false, typ: rtype, tag: ""}, {prop: "pkgPath", name: "pkgPath", embedded: false, exported: false, typ: name, tag: ""}, {prop: "fields", name: "fields", embedded: false, exported: false, typ: sliceType$15, tag: ""}]);
	Method.init("", [{prop: "Name", name: "Name", embedded: false, exported: true, typ: $String, tag: ""}, {prop: "PkgPath", name: "PkgPath", embedded: false, exported: true, typ: $String, tag: ""}, {prop: "Type", name: "Type", embedded: false, exported: true, typ: Type, tag: ""}, {prop: "Func", name: "Func", embedded: false, exported: true, typ: Value, tag: ""}, {prop: "Index", name: "Index", embedded: false, exported: true, typ: $Int, tag: ""}]);
	StructField.init("", [{prop: "Name", name: "Name", embedded: false, exported: true, typ: $String, tag: ""}, {prop: "PkgPath", name: "PkgPath", embedded: false, exported: true, typ: $String, tag: ""}, {prop: "Type", name: "Type", embedded: false, exported: true, typ: Type, tag: ""}, {prop: "Tag", name: "Tag", embedded: false, exported: true, typ: StructTag, tag: ""}, {prop: "Offset", name: "Offset", embedded: false, exported: true, typ: $Uintptr, tag: ""}, {prop: "Index", name: "Index", embedded: false, exported: true, typ: sliceType$7, tag: ""}, {prop: "Anonymous", name: "Anonymous", embedded: false, exported: true, typ: $Bool, tag: ""}]);
	fieldScan.init("reflect", [{prop: "typ", name: "typ", embedded: false, exported: false, typ: ptrType$13, tag: ""}, {prop: "index", name: "index", embedded: false, exported: false, typ: sliceType$7, tag: ""}]);
	uncommonType.init("reflect", [{prop: "pkgPath", name: "pkgPath", embedded: false, exported: false, typ: nameOff, tag: ""}, {prop: "mcount", name: "mcount", embedded: false, exported: false, typ: $Uint16, tag: ""}, {prop: "xcount", name: "xcount", embedded: false, exported: false, typ: $Uint16, tag: ""}, {prop: "moff", name: "moff", embedded: false, exported: false, typ: $Uint32, tag: ""}, {prop: "_methods", name: "_methods", embedded: false, exported: false, typ: sliceType$11, tag: ""}]);
	funcType.init("reflect", [{prop: "rtype", name: "rtype", embedded: true, exported: false, typ: rtype, tag: "reflect:\"func\""}, {prop: "inCount", name: "inCount", embedded: false, exported: false, typ: $Uint16, tag: ""}, {prop: "outCount", name: "outCount", embedded: false, exported: false, typ: $Uint16, tag: ""}, {prop: "_in", name: "_in", embedded: false, exported: false, typ: sliceType$2, tag: ""}, {prop: "_out", name: "_out", embedded: false, exported: false, typ: sliceType$2, tag: ""}]);
	name.init("reflect", [{prop: "bytes", name: "bytes", embedded: false, exported: false, typ: ptrType$14, tag: ""}]);
	nameData.init("reflect", [{prop: "name", name: "name", embedded: false, exported: false, typ: $String, tag: ""}, {prop: "tag", name: "tag", embedded: false, exported: false, typ: $String, tag: ""}, {prop: "exported", name: "exported", embedded: false, exported: false, typ: $Bool, tag: ""}, {prop: "embedded", name: "embedded", embedded: false, exported: false, typ: $Bool, tag: ""}, {prop: "pkgPath", name: "pkgPath", embedded: false, exported: false, typ: $String, tag: ""}]);
	hiter.init("reflect", [{prop: "t", name: "t", embedded: false, exported: false, typ: Type, tag: ""}, {prop: "m", name: "m", embedded: false, exported: false, typ: ptrType$2, tag: ""}, {prop: "keys", name: "keys", embedded: false, exported: false, typ: ptrType$2, tag: ""}, {prop: "i", name: "i", embedded: false, exported: false, typ: $Int, tag: ""}, {prop: "last", name: "last", embedded: false, exported: false, typ: ptrType$2, tag: ""}]);
	$init = function() {
		$pkg.$init = function() {};
		/* */ var $f, $c = false, $s = 0, $r; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		$r = errors.$init(); /* */ $s = 1; case 1: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = js.$init(); /* */ $s = 2; case 2: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = abi.$init(); /* */ $s = 3; case 3: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = bytealg.$init(); /* */ $s = 4; case 4: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = goarch.$init(); /* */ $s = 5; case 5: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = itoa.$init(); /* */ $s = 6; case 6: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = unsafeheader.$init(); /* */ $s = 7; case 7: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = math.$init(); /* */ $s = 8; case 8: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = runtime.$init(); /* */ $s = 9; case 9: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = strconv.$init(); /* */ $s = 10; case 10: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = sync.$init(); /* */ $s = 11; case 11: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = unicode.$init(); /* */ $s = 12; case 12: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = utf8.$init(); /* */ $s = 13; case 13: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		nameOffList = sliceType$1.nil;
		typeOffList = sliceType$2.nil;
		kindNames = new sliceType$3(["invalid", "bool", "int", "int8", "int16", "int32", "int64", "uint", "uint8", "uint16", "uint32", "uint64", "uintptr", "float32", "float64", "complex64", "complex128", "array", "chan", "func", "interface", "map", "ptr", "slice", "string", "struct", "unsafe.Pointer"]);
		initialized = false;
		nameMap = new $global.Map();
		bytesType = $assertType(TypeOf((sliceType$4.nil)), ptrType$1);
		uint8Type = $assertType(TypeOf(new $Uint8(0)), ptrType$1);
		stringType = $assertType(TypeOf(new $String("")), ptrType$1);
		callHelper = $assertType($internalize($call, $emptyInterface), funcType$1);
		jsObjectPtr = reflectType($jsObjectPtr);
		selectHelper = $assertType($internalize($select, $emptyInterface), funcType$1);
		$r = init(); /* */ $s = 14; case 14: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		/* */ } return; } if ($f === undefined) { $f = { $blk: $init }; } $f.$s = $s; $f.$r = $r; return $f;
	};
	$pkg.$init = $init;
	return $pkg;
})();
$packages["syscall/js"] = (function() {
	var $pkg = {}, $init, js, Type, Func, Error, Value, ValueError, sliceType, funcType, arrayType, sliceType$1, mapType, sliceType$2, ptrType, ptrType$1, ptrType$2, typeNames, id, instanceOf, typeOf, Global, Null, Undefined, FuncOf, objectToValue, init, getValueType, ValueOf, convertArgs, convertJSError;
	js = $packages["github.com/gopherjs/gopherjs/js"];
	Type = $pkg.Type = $newType(4, $kindInt, "js.Type", true, "syscall/js", true, null);
	Func = $pkg.Func = $newType(0, $kindStruct, "js.Func", true, "syscall/js", true, function(Value_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.Value = new Value.ptr(null, false, arrayType.zero());
			return;
		}
		this.Value = Value_;
	});
	Error = $pkg.Error = $newType(0, $kindStruct, "js.Error", true, "syscall/js", true, function(Value_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.Value = new Value.ptr(null, false, arrayType.zero());
			return;
		}
		this.Value = Value_;
	});
	Value = $pkg.Value = $newType(0, $kindStruct, "js.Value", true, "syscall/js", true, function(v_, inited_, _$2_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.v = null;
			this.inited = false;
			this._$2 = arrayType.zero();
			return;
		}
		this.v = v_;
		this.inited = inited_;
		this._$2 = _$2_;
	});
	ValueError = $pkg.ValueError = $newType(0, $kindStruct, "js.ValueError", true, "syscall/js", true, function(Method_, Type_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.Method = "";
			this.Type = 0;
			return;
		}
		this.Method = Method_;
		this.Type = Type_;
	});
	sliceType = $sliceType($String);
	funcType = $funcType([], [], false);
	arrayType = $arrayType(funcType, 0);
	sliceType$1 = $sliceType(Value);
	mapType = $mapType($String, $emptyInterface);
	sliceType$2 = $sliceType($emptyInterface);
	ptrType = $ptrType(js.Error);
	ptrType$1 = $ptrType(js.Object);
	ptrType$2 = $ptrType(ValueError);
	Type.prototype.String = function() {
		var t;
		t = this.$val;
		if (((t >> 0)) < 0 || typeNames.$length <= ((t >> 0))) {
			$panic(new $String("bad type"));
		}
		return ((t < 0 || t >= typeNames.$length) ? ($throwRuntimeError("index out of range"), undefined) : typeNames.$array[typeNames.$offset + t]);
	};
	$ptrType(Type).prototype.String = function() { return new Type(this.$get()).String(); };
	Type.prototype.isObject = function() {
		var t;
		t = this.$val;
		return (t === 6) || (t === 7);
	};
	$ptrType(Type).prototype.isObject = function() { return new Type(this.$get()).isObject(); };
	Global = function() {
		return objectToValue($global);
	};
	$pkg.Global = Global;
	Null = function() {
		return objectToValue(null);
	};
	$pkg.Null = Null;
	Undefined = function() {
		return objectToValue(undefined);
	};
	$pkg.Undefined = Undefined;
	Func.ptr.prototype.Release = function() {
		var f;
		f = this;
		$exportedFunctions = ($parseInt($exportedFunctions) >> 0) - 1 >> 0;
		Value.copy(f.Value, Null());
	};
	Func.prototype.Release = function() { return this.$val.Release(); };
	FuncOf = function(fn) {
		var fn;
		$exportedFunctions = ($parseInt($exportedFunctions) >> 0) + 1 >> 0;
		return new Func.ptr($clone(objectToValue(js.MakeFunc((function $b(this$1, args) {
			var {$24r, _i, _r, _ref, a, args, i, this$1, vargs, $s, $r, $c} = $restore(this, {this$1, args});
			/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
			vargs = $makeSlice(sliceType$1, args.$length);
			_ref = args;
			_i = 0;
			while (true) {
				if (!(_i < _ref.$length)) { break; }
				i = _i;
				a = ((_i < 0 || _i >= _ref.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref.$array[_ref.$offset + _i]);
				Value.copy(((i < 0 || i >= vargs.$length) ? ($throwRuntimeError("index out of range"), undefined) : vargs.$array[vargs.$offset + i]), objectToValue(a));
				_i++;
			}
			_r = fn($clone(objectToValue(this$1), Value), vargs); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
			$24r = _r;
			$s = 2; case 2: return $24r;
			/* */ } return; } var $f = {$blk: $b, $c: true, $r, $24r, _i, _r, _ref, a, args, i, this$1, vargs, $s};return $f;
		}))), Value));
	};
	$pkg.FuncOf = FuncOf;
	Error.ptr.prototype.Error = function() {
		var e;
		e = this;
		return "JavaScript error: " + $clone($clone(e.Value, Value).Get("message"), Value).String();
	};
	Error.prototype.Error = function() { return this.$val.Error(); };
	objectToValue = function(obj) {
		var obj;
		if (obj === undefined) {
			return new Value.ptr(null, false, arrayType.zero());
		}
		return new Value.ptr(obj, true, arrayType.zero());
	};
	init = function() {
		if (!($global === null)) {
			id = $id;
			instanceOf = $instanceOf;
			typeOf = $typeOf;
		}
	};
	getValueType = function(obj) {
		var _i, _ref, name, name2, obj, type2;
		if (obj === null) {
			return 1;
		}
		name = $internalize(typeOf(obj), $String);
		_ref = typeNames;
		_i = 0;
		while (true) {
			if (!(_i < _ref.$length)) { break; }
			type2 = _i;
			name2 = ((_i < 0 || _i >= _ref.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref.$array[_ref.$offset + _i]);
			if (name === name2) {
				return ((type2 >> 0));
			}
			_i++;
		}
		return 6;
	};
	ValueOf = function(x) {
		var _ref, x, x$1, x$2, x$3, x$4, x$5;
		_ref = x;
		if ($assertType(_ref, Value, true)[1]) {
			x$1 = $clone(_ref.$val, Value);
			return x$1;
		} else if ($assertType(_ref, Func, true)[1]) {
			x$2 = $clone(_ref.$val, Func);
			return x$2.Value;
		} else if (_ref === $ifaceNil) {
			x$3 = _ref;
			return Null();
		} else if ($assertType(_ref, $Bool, true)[1] || $assertType(_ref, $Int, true)[1] || $assertType(_ref, $Int8, true)[1] || $assertType(_ref, $Int16, true)[1] || $assertType(_ref, $Int32, true)[1] || $assertType(_ref, $Int64, true)[1] || $assertType(_ref, $Uint, true)[1] || $assertType(_ref, $Uint8, true)[1] || $assertType(_ref, $Uint16, true)[1] || $assertType(_ref, $Uint32, true)[1] || $assertType(_ref, $Uint64, true)[1] || $assertType(_ref, $Float32, true)[1] || $assertType(_ref, $Float64, true)[1] || $assertType(_ref, $UnsafePointer, true)[1] || $assertType(_ref, $String, true)[1] || $assertType(_ref, mapType, true)[1] || $assertType(_ref, sliceType$2, true)[1]) {
			x$4 = _ref;
			return objectToValue(id($externalize(x$4, $emptyInterface)));
		} else {
			x$5 = _ref;
			$panic(new $String("ValueOf: invalid value"));
		}
	};
	$pkg.ValueOf = ValueOf;
	Value.ptr.prototype.internal = function() {
		var v;
		v = this;
		if (!v.inited) {
			return undefined;
		}
		return v.v;
	};
	Value.prototype.internal = function() { return this.$val.internal(); };
	Value.ptr.prototype.Bool = function() {
		var v, vType;
		v = this;
		vType = $clone(v, Value).Type();
		if (!((vType === 2))) {
			$panic(new ValueError.ptr("Value.Bool", vType));
		}
		return !!($clone(v, Value).internal());
	};
	Value.prototype.Bool = function() { return this.$val.Bool(); };
	convertArgs = function(args) {
		var _i, _ref, arg, args, newArgs, v;
		newArgs = new sliceType$2([]);
		_ref = args;
		_i = 0;
		while (true) {
			if (!(_i < _ref.$length)) { break; }
			arg = ((_i < 0 || _i >= _ref.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref.$array[_ref.$offset + _i]);
			v = $clone(ValueOf(arg), Value);
			newArgs = $append(newArgs, new $jsObjectPtr($clone(v, Value).internal()));
			_i++;
		}
		return newArgs;
	};
	convertJSError = function() {
		var _tuple, err, jsErr, ok, x;
		err = $recover();
		if ($interfaceIsEqual(err, $ifaceNil)) {
			return;
		}
		_tuple = $assertType(err, ptrType, true);
		jsErr = _tuple[0];
		ok = _tuple[1];
		if (ok) {
			$panic((x = new Error.ptr($clone(objectToValue(jsErr.Object), Value)), new x.constructor.elem(x)));
		}
		$panic(err);
	};
	Value.ptr.prototype.Call = function(m, args) {
		var {$24r, args, m, obj, propType, v, vType, $s, $deferred, $r, $c} = $restore(this, {m, args});
		/* */ $s = $s || 0; var $err = null; try { s: while (true) { switch ($s) { case 0: $deferred = []; $curGoroutine.deferStack.push($deferred);
		v = this;
		vType = $clone(v, Value).Type();
		if (!((vType === 6)) && !((vType === 7))) {
			$panic(new ValueError.ptr("Value.Call", vType));
		}
		propType = $clone($clone(v, Value).Get(m), Value).Type();
		if (!((propType === 7))) {
			$panic(new $String("js: Value.Call: property " + m + " is not a function, got " + new Type(propType).String()));
		}
		$deferred.push([convertJSError, []]);
		$24r = objectToValue((obj = $clone(v, Value).internal(), obj[$externalize(m, $String)].apply(obj, $externalize(convertArgs(args), sliceType$2))));
		$s = 1; case 1: return $24r;
		/* */ } return; } } catch(err) { $err = err; $s = -1; return new Value.ptr(null, false, arrayType.zero()); } finally { $callDeferred($deferred, $err); if($curGoroutine.asleep) { var $f = {$blk: Value.ptr.prototype.Call, $c: true, $r, $24r, args, m, obj, propType, v, vType, $s, $deferred};return $f; } }
	};
	Value.prototype.Call = function(m, args) { return this.$val.Call(m, args); };
	Value.ptr.prototype.Float = function() {
		var v, vType;
		v = this;
		vType = $clone(v, Value).Type();
		if (!((vType === 3))) {
			$panic(new ValueError.ptr("Value.Float", vType));
		}
		return $parseFloat($clone(v, Value).internal());
	};
	Value.prototype.Float = function() { return this.$val.Float(); };
	Value.ptr.prototype.Get = function(p) {
		var p, v, vType;
		v = this;
		vType = $clone(v, Value).Type();
		if (!new Type(vType).isObject()) {
			$panic(new ValueError.ptr("Value.Get", vType));
		}
		return objectToValue($clone(v, Value).internal()[$externalize(p, $String)]);
	};
	Value.prototype.Get = function(p) { return this.$val.Get(p); };
	Value.ptr.prototype.Index = function(i) {
		var i, v, vType;
		v = this;
		vType = $clone(v, Value).Type();
		if (!new Type(vType).isObject()) {
			$panic(new ValueError.ptr("Value.Index", vType));
		}
		return objectToValue($clone(v, Value).internal()[i]);
	};
	Value.prototype.Index = function(i) { return this.$val.Index(i); };
	Value.ptr.prototype.Int = function() {
		var v, vType;
		v = this;
		vType = $clone(v, Value).Type();
		if (!((vType === 3))) {
			$panic(new ValueError.ptr("Value.Int", vType));
		}
		return $parseInt($clone(v, Value).internal()) >> 0;
	};
	Value.prototype.Int = function() { return this.$val.Int(); };
	Value.ptr.prototype.InstanceOf = function(t) {
		var t, v;
		v = this;
		return !!(instanceOf($clone(v, Value).internal(), $clone(t, Value).internal()));
	};
	Value.prototype.InstanceOf = function(t) { return this.$val.InstanceOf(t); };
	Value.ptr.prototype.Invoke = function(args) {
		var args, v, vType;
		v = this;
		vType = $clone(v, Value).Type();
		if (!((vType === 7))) {
			$panic(new ValueError.ptr("Value.Invoke", vType));
		}
		return objectToValue($clone(v, Value).internal().apply(undefined, $externalize(convertArgs(args), sliceType$2)));
	};
	Value.prototype.Invoke = function(args) { return this.$val.Invoke(args); };
	Value.ptr.prototype.JSValue = function() {
		var v;
		v = this;
		return v;
	};
	Value.prototype.JSValue = function() { return this.$val.JSValue(); };
	Value.ptr.prototype.Length = function() {
		var v;
		v = this;
		return $parseInt($clone(v, Value).internal().length);
	};
	Value.prototype.Length = function() { return this.$val.Length(); };
	Value.ptr.prototype.New = function(args) {
		var {$24r, args, v, $s, $deferred, $r, $c} = $restore(this, {args});
		/* */ $s = $s || 0; var $err = null; try { s: while (true) { switch ($s) { case 0: $deferred = []; $curGoroutine.deferStack.push($deferred);
		v = [v];
		v[0] = this;
		$deferred.push([(function(v) { return function() {
			var _tuple, err, jsErr, ok, vType, x;
			err = $recover();
			if ($interfaceIsEqual(err, $ifaceNil)) {
				return;
			}
			vType = $clone(v[0], Value).Type();
			if (!((vType === 7))) {
				$panic(new ValueError.ptr("Value.New", vType));
			}
			_tuple = $assertType(err, ptrType, true);
			jsErr = _tuple[0];
			ok = _tuple[1];
			if (ok) {
				$panic((x = new Error.ptr($clone(objectToValue(jsErr.Object), Value)), new x.constructor.elem(x)));
			}
			$panic(err);
		}; })(v), []]);
		$24r = objectToValue(new ($global.Function.prototype.bind.apply($clone(v[0], Value).internal(), [undefined].concat($externalize(convertArgs(args), sliceType$2)))));
		$s = 1; case 1: return $24r;
		/* */ } return; } } catch(err) { $err = err; $s = -1; return new Value.ptr(null, false, arrayType.zero()); } finally { $callDeferred($deferred, $err); if($curGoroutine.asleep) { var $f = {$blk: Value.ptr.prototype.New, $c: true, $r, $24r, args, v, $s, $deferred};return $f; } }
	};
	Value.prototype.New = function(args) { return this.$val.New(args); };
	Value.ptr.prototype.Set = function(p, x) {
		var p, v, vType, x, x$1;
		v = this;
		vType = $clone(v, Value).Type();
		if (!new Type(vType).isObject()) {
			$panic(new ValueError.ptr("Value.Set", vType));
		}
		$clone(v, Value).internal()[$externalize(p, $String)] = $externalize((x$1 = convertArgs(new sliceType$2([x])), (0 >= x$1.$length ? ($throwRuntimeError("index out of range"), undefined) : x$1.$array[x$1.$offset + 0])), $emptyInterface);
	};
	Value.prototype.Set = function(p, x) { return this.$val.Set(p, x); };
	Value.ptr.prototype.SetIndex = function(i, x) {
		var i, v, vType, x, x$1;
		v = this;
		vType = $clone(v, Value).Type();
		if (!new Type(vType).isObject()) {
			$panic(new ValueError.ptr("Value.SetIndex", vType));
		}
		$clone(v, Value).internal()[i] = $externalize((x$1 = convertArgs(new sliceType$2([x])), (0 >= x$1.$length ? ($throwRuntimeError("index out of range"), undefined) : x$1.$array[x$1.$offset + 0])), $emptyInterface);
	};
	Value.prototype.SetIndex = function(i, x) { return this.$val.SetIndex(i, x); };
	Value.ptr.prototype.String = function() {
		var _1, v;
		v = this;
		_1 = $clone(v, Value).Type();
		if (_1 === (4)) {
			return $internalize($clone(v, Value).internal(), $String);
		} else if (_1 === (0)) {
			return "<undefined>";
		} else if (_1 === (1)) {
			return "<null>";
		} else if (_1 === (2)) {
			return "<boolean: " + $internalize($clone(v, Value).internal(), $String) + ">";
		} else if (_1 === (3)) {
			return "<number: " + $internalize($clone(v, Value).internal(), $String) + ">";
		} else if (_1 === (5)) {
			return "<symbol>";
		} else if (_1 === (6)) {
			return "<object>";
		} else if (_1 === (7)) {
			return "<function>";
		} else {
			$panic(new $String("bad type"));
		}
	};
	Value.prototype.String = function() { return this.$val.String(); };
	Value.ptr.prototype.Truthy = function() {
		var v;
		v = this;
		return !!($clone(v, Value).internal());
	};
	Value.prototype.Truthy = function() { return this.$val.Truthy(); };
	Value.ptr.prototype.Type = function() {
		var v;
		v = this;
		return (getValueType($clone(v, Value).internal()));
	};
	Value.prototype.Type = function() { return this.$val.Type(); };
	Value.ptr.prototype.IsNull = function() {
		var v;
		v = this;
		return $clone(v, Value).Type() === 1;
	};
	Value.prototype.IsNull = function() { return this.$val.IsNull(); };
	Value.ptr.prototype.IsUndefined = function() {
		var v;
		v = this;
		return !v.inited;
	};
	Value.prototype.IsUndefined = function() { return this.$val.IsUndefined(); };
	Value.ptr.prototype.IsNaN = function() {
		var v;
		v = this;
		return !!($global.isNaN($clone(v, Value).internal()));
	};
	Value.prototype.IsNaN = function() { return this.$val.IsNaN(); };
	Value.ptr.prototype.Delete = function(p) {
		var p, v, vType;
		v = this;
		vType = $clone(v, Value).Type();
		if (!new Type(vType).isObject()) {
			$panic(new ValueError.ptr("Value.Delete", vType));
		}
		delete $clone(v, Value).internal()[$externalize(p, $String)];
	};
	Value.prototype.Delete = function(p) { return this.$val.Delete(p); };
	Value.ptr.prototype.Equal = function(w) {
		var v, w;
		v = this;
		return $clone(v, Value).internal() === $clone(w, Value).internal();
	};
	Value.prototype.Equal = function(w) { return this.$val.Equal(w); };
	ValueError.ptr.prototype.Error = function() {
		var e;
		e = this;
		return "syscall/js: call of " + e.Method + " on " + new Type(e.Type).String();
	};
	ValueError.prototype.Error = function() { return this.$val.Error(); };
	Type.methods = [{prop: "String", name: "String", pkg: "", typ: $funcType([], [$String], false)}, {prop: "isObject", name: "isObject", pkg: "syscall/js", typ: $funcType([], [$Bool], false)}];
	Func.methods = [{prop: "Release", name: "Release", pkg: "", typ: $funcType([], [], false)}];
	Error.methods = [{prop: "Error", name: "Error", pkg: "", typ: $funcType([], [$String], false)}];
	Value.methods = [{prop: "internal", name: "internal", pkg: "syscall/js", typ: $funcType([], [ptrType$1], false)}, {prop: "Bool", name: "Bool", pkg: "", typ: $funcType([], [$Bool], false)}, {prop: "Call", name: "Call", pkg: "", typ: $funcType([$String, sliceType$2], [Value], true)}, {prop: "Float", name: "Float", pkg: "", typ: $funcType([], [$Float64], false)}, {prop: "Get", name: "Get", pkg: "", typ: $funcType([$String], [Value], false)}, {prop: "Index", name: "Index", pkg: "", typ: $funcType([$Int], [Value], false)}, {prop: "Int", name: "Int", pkg: "", typ: $funcType([], [$Int], false)}, {prop: "InstanceOf", name: "InstanceOf", pkg: "", typ: $funcType([Value], [$Bool], false)}, {prop: "Invoke", name: "Invoke", pkg: "", typ: $funcType([sliceType$2], [Value], true)}, {prop: "JSValue", name: "JSValue", pkg: "", typ: $funcType([], [Value], false)}, {prop: "Length", name: "Length", pkg: "", typ: $funcType([], [$Int], false)}, {prop: "New", name: "New", pkg: "", typ: $funcType([sliceType$2], [Value], true)}, {prop: "Set", name: "Set", pkg: "", typ: $funcType([$String, $emptyInterface], [], false)}, {prop: "SetIndex", name: "SetIndex", pkg: "", typ: $funcType([$Int, $emptyInterface], [], false)}, {prop: "String", name: "String", pkg: "", typ: $funcType([], [$String], false)}, {prop: "Truthy", name: "Truthy", pkg: "", typ: $funcType([], [$Bool], false)}, {prop: "Type", name: "Type", pkg: "", typ: $funcType([], [Type], false)}, {prop: "IsNull", name: "IsNull", pkg: "", typ: $funcType([], [$Bool], false)}, {prop: "IsUndefined", name: "IsUndefined", pkg: "", typ: $funcType([], [$Bool], false)}, {prop: "IsNaN", name: "IsNaN", pkg: "", typ: $funcType([], [$Bool], false)}, {prop: "Delete", name: "Delete", pkg: "", typ: $funcType([$String], [], false)}, {prop: "Equal", name: "Equal", pkg: "", typ: $funcType([Value], [$Bool], false)}];
	ptrType$2.methods = [{prop: "Error", name: "Error", pkg: "", typ: $funcType([], [$String], false)}];
	Func.init("", [{prop: "Value", name: "Value", embedded: true, exported: true, typ: Value, tag: ""}]);
	Error.init("", [{prop: "Value", name: "Value", embedded: true, exported: true, typ: Value, tag: ""}]);
	Value.init("syscall/js", [{prop: "v", name: "v", embedded: false, exported: false, typ: ptrType$1, tag: ""}, {prop: "inited", name: "inited", embedded: false, exported: false, typ: $Bool, tag: ""}, {prop: "_$2", name: "_", embedded: false, exported: false, typ: arrayType, tag: ""}]);
	ValueError.init("", [{prop: "Method", name: "Method", embedded: false, exported: true, typ: $String, tag: ""}, {prop: "Type", name: "Type", embedded: false, exported: true, typ: Type, tag: ""}]);
	$init = function() {
		$pkg.$init = function() {};
		/* */ var $f, $c = false, $s = 0, $r; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		$r = js.$init(); /* */ $s = 1; case 1: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		id = null;
		instanceOf = null;
		typeOf = null;
		typeNames = new sliceType(["undefined", "null", "boolean", "number", "string", "symbol", "object", "function"]);
		init();
		/* */ } return; } if ($f === undefined) { $f = { $blk: $init }; } $f.$s = $s; $f.$r = $r; return $f;
	};
	$pkg.$init = $init;
	return $pkg;
})();
$packages["github.com/hexops/vecty"] = (function() {
	var $pkg = {}, $init, reflect, js, EventListener, MarkupOrChild, Applyer, markupFunc, MarkupList, Event, jsFuncImpl, wrappedObject, Core, Component, Copier, Mounter, Unmounter, Keyer, ComponentOrHTML, RenderSkipper, HTML, List, KeyedList, batchRenderer, ElementMismatchError, InvalidTargetError, jsFunc, jsObject, sliceType, ptrType, structType, sliceType$1, sliceType$2, funcType, arrayType, sliceType$3, ptrType$1, sliceType$4, ptrType$2, sliceType$5, sliceType$6, sliceType$7, ptrType$3, funcType$1, funcType$2, ptrType$4, mapType, mapType$1, mapType$2, mapType$3, ptrType$5, mapType$4, globalValue, batch, isTest, apply, Style, Attribute, Markup, replaceNode, init, tinyGoAssertCopier, toLower, global, undefined$1, funcOf, wrapObject, unwrap, Tag, extractHTML, sameType, copyComponent, copyProps, render, renderComponent, mountUnmount, mount, unmount, requestAnimationFrame, RenderBody, renderIntoNode;
	reflect = $packages["reflect"];
	js = $packages["syscall/js"];
	EventListener = $pkg.EventListener = $newType(0, $kindStruct, "vecty.EventListener", true, "github.com/hexops/vecty", true, function(Name_, Listener_, callPreventDefault_, callStopPropagation_, wrapper_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.Name = "";
			this.Listener = $throwNilPointerError;
			this.callPreventDefault = false;
			this.callStopPropagation = false;
			this.wrapper = $ifaceNil;
			return;
		}
		this.Name = Name_;
		this.Listener = Listener_;
		this.callPreventDefault = callPreventDefault_;
		this.callStopPropagation = callStopPropagation_;
		this.wrapper = wrapper_;
	});
	MarkupOrChild = $pkg.MarkupOrChild = $newType(8, $kindInterface, "vecty.MarkupOrChild", true, "github.com/hexops/vecty", true, null);
	Applyer = $pkg.Applyer = $newType(8, $kindInterface, "vecty.Applyer", true, "github.com/hexops/vecty", true, null);
	markupFunc = $pkg.markupFunc = $newType(4, $kindFunc, "vecty.markupFunc", true, "github.com/hexops/vecty", false, null);
	MarkupList = $pkg.MarkupList = $newType(0, $kindStruct, "vecty.MarkupList", true, "github.com/hexops/vecty", true, function(list_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.list = sliceType$1.nil;
			return;
		}
		this.list = list_;
	});
	Event = $pkg.Event = $newType(0, $kindStruct, "vecty.Event", true, "github.com/hexops/vecty", true, function(Value_, Target_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.Value = new js.Value.ptr(null, false, arrayType.zero());
			this.Target = new js.Value.ptr(null, false, arrayType.zero());
			return;
		}
		this.Value = Value_;
		this.Target = Target_;
	});
	jsFuncImpl = $pkg.jsFuncImpl = $newType(0, $kindStruct, "vecty.jsFuncImpl", true, "github.com/hexops/vecty", false, function(f_, goFunc_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.f = new js.Func.ptr(new js.Value.ptr(null, false, arrayType.zero()));
			this.goFunc = $throwNilPointerError;
			return;
		}
		this.f = f_;
		this.goFunc = goFunc_;
	});
	wrappedObject = $pkg.wrappedObject = $newType(0, $kindStruct, "vecty.wrappedObject", true, "github.com/hexops/vecty", false, function(j_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.j = new js.Value.ptr(null, false, arrayType.zero());
			return;
		}
		this.j = j_;
	});
	Core = $pkg.Core = $newType(0, $kindStruct, "vecty.Core", true, "github.com/hexops/vecty", true, function(prevRenderComponent_, prevRender_, mounted_, unmounted_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.prevRenderComponent = $ifaceNil;
			this.prevRender = $ifaceNil;
			this.mounted = false;
			this.unmounted = false;
			return;
		}
		this.prevRenderComponent = prevRenderComponent_;
		this.prevRender = prevRender_;
		this.mounted = mounted_;
		this.unmounted = unmounted_;
	});
	Component = $pkg.Component = $newType(8, $kindInterface, "vecty.Component", true, "github.com/hexops/vecty", true, null);
	Copier = $pkg.Copier = $newType(8, $kindInterface, "vecty.Copier", true, "github.com/hexops/vecty", true, null);
	Mounter = $pkg.Mounter = $newType(8, $kindInterface, "vecty.Mounter", true, "github.com/hexops/vecty", true, null);
	Unmounter = $pkg.Unmounter = $newType(8, $kindInterface, "vecty.Unmounter", true, "github.com/hexops/vecty", true, null);
	Keyer = $pkg.Keyer = $newType(8, $kindInterface, "vecty.Keyer", true, "github.com/hexops/vecty", true, null);
	ComponentOrHTML = $pkg.ComponentOrHTML = $newType(8, $kindInterface, "vecty.ComponentOrHTML", true, "github.com/hexops/vecty", true, null);
	RenderSkipper = $pkg.RenderSkipper = $newType(8, $kindInterface, "vecty.RenderSkipper", true, "github.com/hexops/vecty", true, null);
	HTML = $pkg.HTML = $newType(0, $kindStruct, "vecty.HTML", true, "github.com/hexops/vecty", true, function(node_, namespace_, tag_, text_, innerHTML_, classes_, styles_, dataset_, properties_, attributes_, eventListeners_, children_, key_, keyedChildren_, insertBeforeNode_, lastRenderedChild_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.node = $ifaceNil;
			this.namespace = "";
			this.tag = "";
			this.text = "";
			this.innerHTML = "";
			this.classes = false;
			this.styles = false;
			this.dataset = false;
			this.properties = false;
			this.attributes = false;
			this.eventListeners = sliceType$5.nil;
			this.children = sliceType$6.nil;
			this.key = $ifaceNil;
			this.keyedChildren = false;
			this.insertBeforeNode = $ifaceNil;
			this.lastRenderedChild = ptrType.nil;
			return;
		}
		this.node = node_;
		this.namespace = namespace_;
		this.tag = tag_;
		this.text = text_;
		this.innerHTML = innerHTML_;
		this.classes = classes_;
		this.styles = styles_;
		this.dataset = dataset_;
		this.properties = properties_;
		this.attributes = attributes_;
		this.eventListeners = eventListeners_;
		this.children = children_;
		this.key = key_;
		this.keyedChildren = keyedChildren_;
		this.insertBeforeNode = insertBeforeNode_;
		this.lastRenderedChild = lastRenderedChild_;
	});
	List = $pkg.List = $newType(12, $kindSlice, "vecty.List", true, "github.com/hexops/vecty", true, null);
	KeyedList = $pkg.KeyedList = $newType(0, $kindStruct, "vecty.KeyedList", true, "github.com/hexops/vecty", true, function(html_, key_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.html = ptrType.nil;
			this.key = $ifaceNil;
			return;
		}
		this.html = html_;
		this.key = key_;
	});
	batchRenderer = $pkg.batchRenderer = $newType(0, $kindStruct, "vecty.batchRenderer", true, "github.com/hexops/vecty", false, function(batch_, idx_, scheduled_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.batch = sliceType.nil;
			this.idx = false;
			this.scheduled = false;
			return;
		}
		this.batch = batch_;
		this.idx = idx_;
		this.scheduled = scheduled_;
	});
	ElementMismatchError = $pkg.ElementMismatchError = $newType(0, $kindStruct, "vecty.ElementMismatchError", true, "github.com/hexops/vecty", true, function(method_, got_, want_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.method = "";
			this.got = "";
			this.want = "";
			return;
		}
		this.method = method_;
		this.got = got_;
		this.want = want_;
	});
	InvalidTargetError = $pkg.InvalidTargetError = $newType(0, $kindStruct, "vecty.InvalidTargetError", true, "github.com/hexops/vecty", true, function(method_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.method = "";
			return;
		}
		this.method = method_;
	});
	jsFunc = $pkg.jsFunc = $newType(8, $kindInterface, "vecty.jsFunc", true, "github.com/hexops/vecty", false, null);
	jsObject = $pkg.jsObject = $newType(8, $kindInterface, "vecty.jsObject", true, "github.com/hexops/vecty", false, null);
	sliceType = $sliceType(Component);
	ptrType = $ptrType(HTML);
	structType = $structType("", []);
	sliceType$1 = $sliceType(Applyer);
	sliceType$2 = $sliceType($emptyInterface);
	funcType = $funcType([], [], false);
	arrayType = $arrayType(funcType, 0);
	sliceType$3 = $sliceType(jsObject);
	ptrType$1 = $ptrType(jsFuncImpl);
	sliceType$4 = $sliceType(Mounter);
	ptrType$2 = $ptrType(EventListener);
	sliceType$5 = $sliceType(ptrType$2);
	sliceType$6 = $sliceType(ComponentOrHTML);
	sliceType$7 = $sliceType(MarkupOrChild);
	ptrType$3 = $ptrType(Event);
	funcType$1 = $funcType([ptrType$3], [], false);
	funcType$2 = $funcType([jsObject, sliceType$3], [$emptyInterface], false);
	ptrType$4 = $ptrType(Core);
	mapType = $mapType($String, structType);
	mapType$1 = $mapType($String, $String);
	mapType$2 = $mapType($String, $emptyInterface);
	mapType$3 = $mapType($emptyInterface, ComponentOrHTML);
	ptrType$5 = $ptrType(batchRenderer);
	mapType$4 = $mapType(Component, $Int);
	EventListener.ptr.prototype.PreventDefault = function() {
		var l;
		l = this;
		l.callPreventDefault = true;
		return l;
	};
	EventListener.prototype.PreventDefault = function() { return this.$val.PreventDefault(); };
	EventListener.ptr.prototype.StopPropagation = function() {
		var l;
		l = this;
		l.callStopPropagation = true;
		return l;
	};
	EventListener.prototype.StopPropagation = function() { return this.$val.StopPropagation(); };
	EventListener.ptr.prototype.Apply = function(h) {
		var h, l;
		l = this;
		h.eventListeners = $append(h.eventListeners, l);
	};
	EventListener.prototype.Apply = function(h) { return this.$val.Apply(h); };
	apply = function(m, h) {
		var {_r, _ref, h, m, m$1, m$2, m$3, m$4, $s, $r, $c} = $restore(this, {m, h});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		_ref = m;
		/* */ if ($assertType(_ref, MarkupList, true)[1]) { $s = 1; continue; }
		/* */ if (_ref === $ifaceNil) { $s = 2; continue; }
		/* */ if ($assertType(_ref, Component, true)[1] || $assertType(_ref, ptrType, true)[1] || $assertType(_ref, List, true)[1] || $assertType(_ref, KeyedList, true)[1]) { $s = 3; continue; }
		/* */ $s = 4; continue;
		/* if ($assertType(_ref, MarkupList, true)[1]) { */ case 1:
			m$1 = $clone(_ref.$val, MarkupList);
			$r = $clone(m$1, MarkupList).Apply(h); /* */ $s = 6; case 6: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
			$s = 5; continue;
		/* } else if (_ref === $ifaceNil) { */ case 2:
			m$2 = _ref;
			h.children = $append(h.children, $ifaceNil);
			$s = 5; continue;
		/* } else if ($assertType(_ref, Component, true)[1] || $assertType(_ref, ptrType, true)[1] || $assertType(_ref, List, true)[1] || $assertType(_ref, KeyedList, true)[1]) { */ case 3:
			m$3 = _ref;
			h.children = $append(h.children, $assertType(m$3, ComponentOrHTML));
			$s = 5; continue;
		/* } else { */ case 4:
			m$4 = _ref;
			_r = reflect.TypeOf(m$4).String(); /* */ $s = 7; case 7: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
			$panic(new $String("vecty: internal error (unexpected MarkupOrChild type " + _r + ")"));
		/* } */ case 5:
		$s = -1; return;
		/* */ } return; } var $f = {$blk: apply, $c: true, $r, _r, _ref, h, m, m$1, m$2, m$3, m$4, $s};return $f;
	};
	markupFunc.prototype.Apply = function(h) {
		var {h, m, $s, $r, $c} = $restore(this, {h});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		m = this.$val;
		$r = m(h); /* */ $s = 1; case 1: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$s = -1; return;
		/* */ } return; } var $f = {$blk: markupFunc.prototype.Apply, $c: true, $r, h, m, $s};return $f;
	};
	$ptrType(markupFunc).prototype.Apply = function(h) { return new markupFunc(this.$get()).Apply(h); };
	Style = function(key, value) {
		var key, value;
		return new markupFunc(((function(h) {
			var _key, h;
			if (h.styles === false) {
				h.styles = new $global.Map();
			}
			_key = key; (h.styles || $throwRuntimeError("assignment to entry in nil map")).set($String.keyFor(_key), { k: _key, v: value });
		})));
	};
	$pkg.Style = Style;
	Attribute = function(key, value) {
		var key, value;
		return new markupFunc(((function(h) {
			var _key, h;
			if (h.attributes === false) {
				h.attributes = new $global.Map();
			}
			_key = key; (h.attributes || $throwRuntimeError("assignment to entry in nil map")).set($String.keyFor(_key), { k: _key, v: value });
		})));
	};
	$pkg.Attribute = Attribute;
	MarkupList.ptr.prototype.Apply = function(h) {
		var {_i, _ref, a, h, m, $s, $r, $c} = $restore(this, {h});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		m = this;
		_ref = m.list;
		_i = 0;
		/* while (true) { */ case 1:
			/* if (!(_i < _ref.$length)) { break; } */ if(!(_i < _ref.$length)) { $s = 2; continue; }
			a = ((_i < 0 || _i >= _ref.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref.$array[_ref.$offset + _i]);
			if ($interfaceIsEqual(a, $ifaceNil)) {
				_i++;
				/* continue; */ $s = 1; continue;
			}
			$r = a.Apply(h); /* */ $s = 3; case 3: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
			_i++;
		$s = 1; continue;
		case 2:
		$s = -1; return;
		/* */ } return; } var $f = {$blk: MarkupList.ptr.prototype.Apply, $c: true, $r, _i, _ref, a, h, m, $s};return $f;
	};
	MarkupList.prototype.Apply = function(h) { return this.$val.Apply(h); };
	Markup = function(m) {
		var m;
		return new MarkupList.ptr(m);
	};
	$pkg.Markup = Markup;
	replaceNode = function(newNode, oldNode) {
		var {_r, _r$1, _r$2, newNode, oldNode, $s, $r, $c} = $restore(this, {newNode, oldNode});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		_r = newNode.Equal(oldNode); /* */ $s = 3; case 3: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		/* */ if (_r) { $s = 1; continue; }
		/* */ $s = 2; continue;
		/* if (_r) { */ case 1:
			$s = -1; return;
		/* } */ case 2:
		_r$1 = oldNode.Get("parentNode"); /* */ $s = 4; case 4: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
		_r$2 = _r$1.Call("replaceChild", new sliceType$2([newNode, oldNode])); /* */ $s = 5; case 5: if($c) { $c = false; _r$2 = _r$2.$blk(); } if (_r$2 && _r$2.$blk !== undefined) { break s; }
		_r$2;
		$s = -1; return;
		/* */ } return; } var $f = {$blk: replaceNode, $c: true, $r, _r, _r$1, _r$2, newNode, oldNode, $s};return $f;
	};
	init = function() {
		var {_r, _r$1, $s, $r, $c} = $restore(this, {});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		if (isTest) {
			$s = -1; return;
		}
		if ($interfaceIsEqual(global(), $ifaceNil)) {
			$panic(new $String("vecty: only WebAssembly, TinyGo, and testing compilation is supported"));
		}
		_r = global().Get("document"); /* */ $s = 3; case 3: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		_r$1 = _r.IsUndefined(); /* */ $s = 4; case 4: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
		/* */ if (_r$1) { $s = 1; continue; }
		/* */ $s = 2; continue;
		/* if (_r$1) { */ case 1:
			$panic(new $String("vecty: only running inside a browser is supported"));
		/* } */ case 2:
		$s = -1; return;
		/* */ } return; } var $f = {$blk: init, $c: true, $r, _r, _r$1, $s};return $f;
	};
	HTML.ptr.prototype.tinyGoCannotIterateNilMaps = function() {
		var h;
		h = this;
	};
	HTML.prototype.tinyGoCannotIterateNilMaps = function() { return this.$val.tinyGoCannotIterateNilMaps(); };
	tinyGoAssertCopier = function(c) {
		var c;
	};
	HTML.ptr.prototype.Node = function() {
		var h;
		h = this;
		if ($interfaceIsEqual(h.node, $ifaceNil)) {
			$panic(new $String("vecty: cannot call (*HTML).Node() before DOM node creation / component mount"));
		}
		return $assertType(h.node, wrappedObject).j;
	};
	HTML.prototype.Node = function() { return this.$val.Node(); };
	toLower = function(s) {
		var {$24r, _r, _r$1, s, x, $s, $r, $c} = $restore(this, {s});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		_r = $clone($clone($clone($clone(js.Global(), js.Value).Get("String"), js.Value).Get("prototype"), js.Value).Get("toLowerCase"), js.Value).Call("call", new sliceType$2([(x = js.ValueOf(new $String(s)), new x.constructor.elem(x))])); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		_r$1 = $clone(_r, js.Value).String(); /* */ $s = 2; case 2: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
		$24r = _r$1;
		$s = 3; case 3: return $24r;
		/* */ } return; } var $f = {$blk: toLower, $c: true, $r, $24r, _r, _r$1, s, x, $s};return $f;
	};
	global = function() {
		if ($interfaceIsEqual(globalValue, $ifaceNil)) {
			globalValue = wrapObject($clone(js.Global(), js.Value));
		}
		return globalValue;
	};
	undefined$1 = function() {
		return new wrappedObject.ptr($clone(js.Undefined(), js.Value));
	};
	funcOf = function(fn) {
		var fn;
		return new jsFuncImpl.ptr($clone(js.FuncOf((function $b(this$1, args) {
			var {$24r, _i, _r, _r$1, _ref, arg, args, i, this$1, wrappedArgs, $s, $r, $c} = $restore(this, {this$1, args});
			/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
			wrappedArgs = $makeSlice(sliceType$3, args.$length);
			_ref = args;
			_i = 0;
			while (true) {
				if (!(_i < _ref.$length)) { break; }
				i = _i;
				arg = $clone(((_i < 0 || _i >= _ref.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref.$array[_ref.$offset + _i]), js.Value);
				((i < 0 || i >= wrappedArgs.$length) ? ($throwRuntimeError("index out of range"), undefined) : wrappedArgs.$array[wrappedArgs.$offset + i] = wrapObject($clone(arg, js.Value)));
				_i++;
			}
			_r = fn(wrapObject($clone(this$1, js.Value)), wrappedArgs); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
			_r$1 = unwrap(_r); /* */ $s = 2; case 2: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
			$24r = _r$1;
			$s = 3; case 3: return $24r;
			/* */ } return; } var $f = {$blk: $b, $c: true, $r, $24r, _i, _r, _r$1, _ref, arg, args, i, this$1, wrappedArgs, $s};return $f;
		})), js.Func), fn);
	};
	jsFuncImpl.ptr.prototype.String = function() {
		var j;
		j = this;
		return "func";
	};
	jsFuncImpl.prototype.String = function() { return this.$val.String(); };
	jsFuncImpl.ptr.prototype.Release = function() {
		var j;
		j = this;
		$clone(j.f, js.Func).Release();
	};
	jsFuncImpl.prototype.Release = function() { return this.$val.Release(); };
	wrapObject = function(j) {
		var j, x;
		if ($clone(j, js.Value).IsNull()) {
			return $ifaceNil;
		}
		return (x = new wrappedObject.ptr($clone(j, js.Value)), new x.constructor.elem(x));
	};
	unwrap = function(value) {
		var _tuple, _tuple$1, ok, ok$1, v, v$1, value, x, x$1;
		_tuple = $assertType(value, wrappedObject, true);
		v = $clone(_tuple[0], wrappedObject);
		ok = _tuple[1];
		if (ok) {
			return (x = v.j, new x.constructor.elem(x));
		}
		_tuple$1 = $assertType(value, ptrType$1, true);
		v$1 = _tuple$1[0];
		ok$1 = _tuple$1[1];
		if (ok$1) {
			return (x$1 = v$1.f, new x$1.constructor.elem(x$1));
		}
		return value;
	};
	wrappedObject.ptr.prototype.Set = function(key, value) {
		var key, value, w;
		w = this;
		$clone(w.j, js.Value).Set(key, unwrap(value));
	};
	wrappedObject.prototype.Set = function(key, value) { return this.$val.Set(key, value); };
	wrappedObject.ptr.prototype.Get = function(key) {
		var key, w;
		w = this;
		return wrapObject($clone($clone(w.j, js.Value).Get(key), js.Value));
	};
	wrappedObject.prototype.Get = function(key) { return this.$val.Get(key); };
	wrappedObject.ptr.prototype.Delete = function(key) {
		var key, w;
		w = this;
		$clone(w.j, js.Value).Delete(key);
	};
	wrappedObject.prototype.Delete = function(key) { return this.$val.Delete(key); };
	wrappedObject.ptr.prototype.Call = function(name, args) {
		var {$24r, _i, _r, _r$1, _ref, arg, args, i, name, w, $s, $r, $c} = $restore(this, {name, args});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		w = this;
		_ref = args;
		_i = 0;
		while (true) {
			if (!(_i < _ref.$length)) { break; }
			i = _i;
			arg = ((_i < 0 || _i >= _ref.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref.$array[_ref.$offset + _i]);
			((i < 0 || i >= args.$length) ? ($throwRuntimeError("index out of range"), undefined) : args.$array[args.$offset + i] = unwrap(arg));
			_i++;
		}
		_r = $clone(w.j, js.Value).Call(name, args); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		_r$1 = wrapObject($clone(_r, js.Value)); /* */ $s = 2; case 2: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
		$24r = _r$1;
		$s = 3; case 3: return $24r;
		/* */ } return; } var $f = {$blk: wrappedObject.ptr.prototype.Call, $c: true, $r, $24r, _i, _r, _r$1, _ref, arg, args, i, name, w, $s};return $f;
	};
	wrappedObject.prototype.Call = function(name, args) { return this.$val.Call(name, args); };
	wrappedObject.ptr.prototype.String = function() {
		var w;
		w = this;
		return $clone(w.j, js.Value).String();
	};
	wrappedObject.prototype.String = function() { return this.$val.String(); };
	wrappedObject.ptr.prototype.Truthy = function() {
		var w;
		w = this;
		return $clone(w.j, js.Value).Truthy();
	};
	wrappedObject.prototype.Truthy = function() { return this.$val.Truthy(); };
	wrappedObject.ptr.prototype.IsUndefined = function() {
		var w;
		w = this;
		return $clone(w.j, js.Value).IsUndefined();
	};
	wrappedObject.prototype.IsUndefined = function() { return this.$val.IsUndefined(); };
	wrappedObject.ptr.prototype.Equal = function(other) {
		var other, w;
		w = this;
		if (!($clone(w.j, js.Value).IsNull() === ($interfaceIsEqual(other, $ifaceNil)))) {
			return false;
		}
		return $clone(w.j, js.Value).Equal($clone($assertType(unwrap(other), js.Value), js.Value));
	};
	wrappedObject.prototype.Equal = function(other) { return this.$val.Equal(other); };
	wrappedObject.ptr.prototype.Bool = function() {
		var w;
		w = this;
		return $clone(w.j, js.Value).Bool();
	};
	wrappedObject.prototype.Bool = function() { return this.$val.Bool(); };
	wrappedObject.ptr.prototype.Int = function() {
		var w;
		w = this;
		return $clone(w.j, js.Value).Int();
	};
	wrappedObject.prototype.Int = function() { return this.$val.Int(); };
	wrappedObject.ptr.prototype.Float = function() {
		var w;
		w = this;
		return $clone(w.j, js.Value).Float();
	};
	wrappedObject.prototype.Float = function() { return this.$val.Float(); };
	Core.ptr.prototype.Context = function() {
		var c;
		c = this;
		return c;
	};
	Core.prototype.Context = function() { return this.$val.Context(); };
	HTML.ptr.prototype.Key = function() {
		var h;
		h = this;
		return h.key;
	};
	HTML.prototype.Key = function() { return this.$val.Key(); };
	HTML.ptr.prototype.createNode = function() {
		var {_r, _r$1, _r$2, _r$3, _r$4, _r$5, h, $s, $r, $c} = $restore(this, {});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		h = this;
			/* */ if (!(h.tag === "") && !(h.text === "")) { $s = 2; continue; }
			/* */ if (h.tag === "" && !(h.innerHTML === "")) { $s = 3; continue; }
			/* */ if (!(h.tag === "") && h.namespace === "") { $s = 4; continue; }
			/* */ if (!(h.tag === "") && !(h.namespace === "")) { $s = 5; continue; }
			/* */ $s = 6; continue;
			/* if (!(h.tag === "") && !(h.text === "")) { */ case 2:
				$panic(new $String("vecty: internal error (only one of HTML.tag or HTML.text may be set)"));
				$s = 7; continue;
			/* } else if (h.tag === "" && !(h.innerHTML === "")) { */ case 3:
				$panic(new $String("vecty: only HTML may have UnsafeHTML attribute"));
				$s = 7; continue;
			/* } else if (!(h.tag === "") && h.namespace === "") { */ case 4:
				_r = global().Get("document"); /* */ $s = 8; case 8: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
				_r$1 = _r.Call("createElement", new sliceType$2([new $String(h.tag)])); /* */ $s = 9; case 9: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
				h.node = _r$1;
				$s = 7; continue;
			/* } else if (!(h.tag === "") && !(h.namespace === "")) { */ case 5:
				_r$2 = global().Get("document"); /* */ $s = 10; case 10: if($c) { $c = false; _r$2 = _r$2.$blk(); } if (_r$2 && _r$2.$blk !== undefined) { break s; }
				_r$3 = _r$2.Call("createElementNS", new sliceType$2([new $String(h.namespace), new $String(h.tag)])); /* */ $s = 11; case 11: if($c) { $c = false; _r$3 = _r$3.$blk(); } if (_r$3 && _r$3.$blk !== undefined) { break s; }
				h.node = _r$3;
				$s = 7; continue;
			/* } else { */ case 6:
				_r$4 = global().Get("document"); /* */ $s = 12; case 12: if($c) { $c = false; _r$4 = _r$4.$blk(); } if (_r$4 && _r$4.$blk !== undefined) { break s; }
				_r$5 = _r$4.Call("createTextNode", new sliceType$2([new $String(h.text)])); /* */ $s = 13; case 13: if($c) { $c = false; _r$5 = _r$5.$blk(); } if (_r$5 && _r$5.$blk !== undefined) { break s; }
				h.node = _r$5;
			/* } */ case 7:
		case 1:
		$s = -1; return;
		/* */ } return; } var $f = {$blk: HTML.ptr.prototype.createNode, $c: true, $r, _r, _r$1, _r$2, _r$3, _r$4, _r$5, h, $s};return $f;
	};
	HTML.prototype.createNode = function() { return this.$val.createNode(); };
	HTML.ptr.prototype.reconcileText = function(prev) {
		var {h, prev, $s, $r, $c} = $restore(this, {prev});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		h = this;
		h.node = prev.node;
		/* */ if (!(h.text === prev.text)) { $s = 1; continue; }
		/* */ $s = 2; continue;
		/* if (!(h.text === prev.text)) { */ case 1:
			$r = h.node.Set("nodeValue", new $String(h.text)); /* */ $s = 3; case 3: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		/* } */ case 2:
		$s = -1; return;
		/* */ } return; } var $f = {$blk: HTML.ptr.prototype.reconcileText, $c: true, $r, h, prev, $s};return $f;
	};
	HTML.prototype.reconcileText = function(prev) { return this.$val.reconcileText(prev); };
	HTML.ptr.prototype.reconcile = function(prev) {
		var {$24r, _r, _r$1, h, prev, $s, $r, $c} = $restore(this, {prev});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		h = this;
			/* */ if (!(prev === ptrType.nil) && h.tag === "" && prev.tag === "") { $s = 2; continue; }
			/* */ if (!(prev === ptrType.nil) && !(h.tag === "") && !(prev.tag === "") && h.tag === prev.tag && h.namespace === prev.namespace) { $s = 3; continue; }
			/* */ $s = 4; continue;
			/* if (!(prev === ptrType.nil) && h.tag === "" && prev.tag === "") { */ case 2:
				$r = h.reconcileText(prev); /* */ $s = 6; case 6: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
				$s = -1; return sliceType$4.nil;
			/* } else if (!(prev === ptrType.nil) && !(h.tag === "") && !(prev.tag === "") && h.tag === prev.tag && h.namespace === prev.namespace) { */ case 3:
				h.node = prev.node;
				$s = 5; continue;
			/* } else { */ case 4:
				if (prev === ptrType.nil) {
					prev = new HTML.ptr($ifaceNil, "", "", "", "", false, false, false, false, false, sliceType$5.nil, sliceType$6.nil, $ifaceNil, false, $ifaceNil, ptrType.nil);
				}
				$r = h.createNode(); /* */ $s = 7; case 7: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
			/* } */ case 5:
		case 1:
		_r = h.node.Equal(prev.node); /* */ $s = 11; case 11: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		/* */ if (!_r) { $s = 8; continue; }
		/* */ $s = 9; continue;
		/* if (!_r) { */ case 8:
			$r = h.reconcileProperties(new HTML.ptr($ifaceNil, "", "", "", "", false, false, false, false, false, sliceType$5.nil, sliceType$6.nil, $ifaceNil, false, $ifaceNil, ptrType.nil)); /* */ $s = 12; case 12: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
			$s = 10; continue;
		/* } else { */ case 9:
			$r = h.reconcileProperties(prev); /* */ $s = 13; case 13: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		/* } */ case 10:
		_r$1 = h.reconcileChildren(prev); /* */ $s = 14; case 14: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
		$24r = _r$1;
		$s = 15; case 15: return $24r;
		/* */ } return; } var $f = {$blk: HTML.ptr.prototype.reconcile, $c: true, $r, $24r, _r, _r$1, h, prev, $s};return $f;
	};
	HTML.prototype.reconcile = function(prev) { return this.$val.reconcile(prev); };
	HTML.ptr.prototype.reconcileProperties = function(prev) {
		var {_1, _entry, _entry$1, _entry$2, _entry$3, _entry$4, _entry$5, _entry$6, _entry$7, _entry$8, _entry$9, _i, _i$1, _i$2, _i$3, _i$4, _i$5, _i$6, _key, _key$1, _key$2, _key$3, _key$4, _keys, _keys$1, _keys$2, _keys$3, _keys$4, _r, _r$1, _r$10, _r$11, _r$2, _r$3, _r$4, _r$5, _r$6, _r$7, _r$8, _r$9, _ref, _ref$1, _ref$2, _ref$3, _ref$4, _ref$5, _ref$6, _size, _size$1, _size$2, _size$3, _size$4, _tuple, classList, dataset, h, l, l$1, l$2, name, name$1, name$2, name$3, name$4, ok, oldValue, oldValue$1, prev, style, value, value$1, value$2, value$3, $s, $r, $c} = $restore(this, {prev});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		h = this;
		_r = h.node.Equal(prev.node); /* */ $s = 3; case 3: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		/* */ if (_r) { $s = 1; continue; }
		/* */ $s = 2; continue;
		/* if (_r) { */ case 1:
			$r = h.removeProperties(prev); /* */ $s = 4; case 4: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		/* } */ case 2:
		h.tinyGoCannotIterateNilMaps();
		_ref = h.eventListeners;
		_i = 0;
		/* while (true) { */ case 5:
			/* if (!(_i < _ref.$length)) { break; } */ if(!(_i < _ref.$length)) { $s = 6; continue; }
			l = [l];
			l$1 = ((_i < 0 || _i >= _ref.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref.$array[_ref.$offset + _i]);
			l[0] = l$1;
			l[0].wrapper = funcOf((function(l) { return function $b(this$1, args) {
				var {_r$1, _r$2, _r$3, args, jsEvent, this$1, x, $s, $r, $c} = $restore(this, {this$1, args});
				/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
				jsEvent = (0 >= args.$length ? ($throwRuntimeError("index out of range"), undefined) : args.$array[args.$offset + 0]);
				/* */ if (l[0].callPreventDefault) { $s = 1; continue; }
				/* */ $s = 2; continue;
				/* if (l[0].callPreventDefault) { */ case 1:
					_r$1 = jsEvent.Call("preventDefault", sliceType$2.nil); /* */ $s = 3; case 3: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
					_r$1;
				/* } */ case 2:
				/* */ if (l[0].callStopPropagation) { $s = 4; continue; }
				/* */ $s = 5; continue;
				/* if (l[0].callStopPropagation) { */ case 4:
					_r$2 = jsEvent.Call("stopPropagation", sliceType$2.nil); /* */ $s = 6; case 6: if($c) { $c = false; _r$2 = _r$2.$blk(); } if (_r$2 && _r$2.$blk !== undefined) { break s; }
					_r$2;
				/* } */ case 5:
				_r$3 = jsEvent.Get("target"); /* */ $s = 7; case 7: if($c) { $c = false; _r$3 = _r$3.$blk(); } if (_r$3 && _r$3.$blk !== undefined) { break s; }
				$r = l[0].Listener(new Event.ptr($clone($assertType(jsEvent, wrappedObject).j, js.Value), $clone($assertType(_r$3, wrappedObject).j, js.Value))); /* */ $s = 8; case 8: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
				$s = -1; return (x = undefined$1(), new x.constructor.elem(x));
				/* */ } return; } var $f = {$blk: $b, $c: true, $r, _r$1, _r$2, _r$3, args, jsEvent, this$1, x, $s};return $f;
			}; })(l));
			_i++;
		$s = 5; continue;
		case 6:
		_ref$1 = h.properties;
		_i$1 = 0;
		_keys = _ref$1 ? _ref$1.keys() : undefined;
		_size = _ref$1 ? _ref$1.size : 0;
		/* while (true) { */ case 7:
			/* if (!(_i$1 < _size)) { break; } */ if(!(_i$1 < _size)) { $s = 8; continue; }
			_key = _keys.next().value;
			_entry = _ref$1.get(_key);
			if (_entry === undefined) {
				_i$1++;
				/* continue; */ $s = 7; continue;
			}
			name = _entry.k;
			value = _entry.v;
			oldValue = $ifaceNil;
				_1 = name;
				/* */ if (_1 === ("value")) { $s = 10; continue; }
				/* */ if (_1 === ("checked")) { $s = 11; continue; }
				/* */ $s = 12; continue;
				/* if (_1 === ("value")) { */ case 10:
					_r$1 = h.node.Get("value"); /* */ $s = 14; case 14: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
					_r$2 = _r$1.String(); /* */ $s = 15; case 15: if($c) { $c = false; _r$2 = _r$2.$blk(); } if (_r$2 && _r$2.$blk !== undefined) { break s; }
					oldValue = new $String(_r$2);
					$s = 13; continue;
				/* } else if (_1 === ("checked")) { */ case 11:
					_r$3 = h.node.Get("checked"); /* */ $s = 16; case 16: if($c) { $c = false; _r$3 = _r$3.$blk(); } if (_r$3 && _r$3.$blk !== undefined) { break s; }
					_r$4 = _r$3.Bool(); /* */ $s = 17; case 17: if($c) { $c = false; _r$4 = _r$4.$blk(); } if (_r$4 && _r$4.$blk !== undefined) { break s; }
					oldValue = new $Bool(_r$4);
					$s = 13; continue;
				/* } else { */ case 12:
					oldValue = (_entry$1 = $mapIndex(prev.properties,$String.keyFor(name)), _entry$1 !== undefined ? _entry$1.v : $ifaceNil);
				/* } */ case 13:
			case 9:
			/* */ if (!($interfaceIsEqual(value, oldValue))) { $s = 18; continue; }
			/* */ $s = 19; continue;
			/* if (!($interfaceIsEqual(value, oldValue))) { */ case 18:
				$r = h.node.Set(name, value); /* */ $s = 20; case 20: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
			/* } */ case 19:
			_i$1++;
		$s = 7; continue;
		case 8:
		_ref$2 = h.attributes;
		_i$2 = 0;
		_keys$1 = _ref$2 ? _ref$2.keys() : undefined;
		_size$1 = _ref$2 ? _ref$2.size : 0;
		/* while (true) { */ case 21:
			/* if (!(_i$2 < _size$1)) { break; } */ if(!(_i$2 < _size$1)) { $s = 22; continue; }
			_key$1 = _keys$1.next().value;
			_entry$2 = _ref$2.get(_key$1);
			if (_entry$2 === undefined) {
				_i$2++;
				/* continue; */ $s = 21; continue;
			}
			name$1 = _entry$2.k;
			value$1 = _entry$2.v;
			/* */ if (!($interfaceIsEqual(value$1, (_entry$3 = $mapIndex(prev.attributes,$String.keyFor(name$1)), _entry$3 !== undefined ? _entry$3.v : $ifaceNil)))) { $s = 23; continue; }
			/* */ $s = 24; continue;
			/* if (!($interfaceIsEqual(value$1, (_entry$3 = $mapIndex(prev.attributes,$String.keyFor(name$1)), _entry$3 !== undefined ? _entry$3.v : $ifaceNil)))) { */ case 23:
				_r$5 = h.node.Call("setAttribute", new sliceType$2([new $String(name$1), value$1])); /* */ $s = 25; case 25: if($c) { $c = false; _r$5 = _r$5.$blk(); } if (_r$5 && _r$5.$blk !== undefined) { break s; }
				_r$5;
			/* } */ case 24:
			_i$2++;
		$s = 21; continue;
		case 22:
		_r$6 = h.node.Get("classList"); /* */ $s = 26; case 26: if($c) { $c = false; _r$6 = _r$6.$blk(); } if (_r$6 && _r$6.$blk !== undefined) { break s; }
		classList = _r$6;
		_ref$3 = h.classes;
		_i$3 = 0;
		_keys$2 = _ref$3 ? _ref$3.keys() : undefined;
		_size$2 = _ref$3 ? _ref$3.size : 0;
		/* while (true) { */ case 27:
			/* if (!(_i$3 < _size$2)) { break; } */ if(!(_i$3 < _size$2)) { $s = 28; continue; }
			_key$2 = _keys$2.next().value;
			_entry$4 = _ref$3.get(_key$2);
			if (_entry$4 === undefined) {
				_i$3++;
				/* continue; */ $s = 27; continue;
			}
			name$2 = _entry$4.k;
			_tuple = (_entry$5 = $mapIndex(prev.classes,$String.keyFor(name$2)), _entry$5 !== undefined ? [_entry$5.v, true] : [new structType.ptr(), false]);
			ok = _tuple[1];
			/* */ if (!ok) { $s = 29; continue; }
			/* */ $s = 30; continue;
			/* if (!ok) { */ case 29:
				_r$7 = classList.Call("add", new sliceType$2([new $String(name$2)])); /* */ $s = 31; case 31: if($c) { $c = false; _r$7 = _r$7.$blk(); } if (_r$7 && _r$7.$blk !== undefined) { break s; }
				_r$7;
			/* } */ case 30:
			_i$3++;
		$s = 27; continue;
		case 28:
		_r$8 = h.node.Get("dataset"); /* */ $s = 32; case 32: if($c) { $c = false; _r$8 = _r$8.$blk(); } if (_r$8 && _r$8.$blk !== undefined) { break s; }
		dataset = _r$8;
		_ref$4 = h.dataset;
		_i$4 = 0;
		_keys$3 = _ref$4 ? _ref$4.keys() : undefined;
		_size$3 = _ref$4 ? _ref$4.size : 0;
		/* while (true) { */ case 33:
			/* if (!(_i$4 < _size$3)) { break; } */ if(!(_i$4 < _size$3)) { $s = 34; continue; }
			_key$3 = _keys$3.next().value;
			_entry$6 = _ref$4.get(_key$3);
			if (_entry$6 === undefined) {
				_i$4++;
				/* continue; */ $s = 33; continue;
			}
			name$3 = _entry$6.k;
			value$2 = _entry$6.v;
			/* */ if (!(value$2 === (_entry$7 = $mapIndex(prev.dataset,$String.keyFor(name$3)), _entry$7 !== undefined ? _entry$7.v : ""))) { $s = 35; continue; }
			/* */ $s = 36; continue;
			/* if (!(value$2 === (_entry$7 = $mapIndex(prev.dataset,$String.keyFor(name$3)), _entry$7 !== undefined ? _entry$7.v : ""))) { */ case 35:
				$r = dataset.Set(name$3, new $String(value$2)); /* */ $s = 37; case 37: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
			/* } */ case 36:
			_i$4++;
		$s = 33; continue;
		case 34:
		_r$9 = h.node.Get("style"); /* */ $s = 38; case 38: if($c) { $c = false; _r$9 = _r$9.$blk(); } if (_r$9 && _r$9.$blk !== undefined) { break s; }
		style = _r$9;
		_ref$5 = h.styles;
		_i$5 = 0;
		_keys$4 = _ref$5 ? _ref$5.keys() : undefined;
		_size$4 = _ref$5 ? _ref$5.size : 0;
		/* while (true) { */ case 39:
			/* if (!(_i$5 < _size$4)) { break; } */ if(!(_i$5 < _size$4)) { $s = 40; continue; }
			_key$4 = _keys$4.next().value;
			_entry$8 = _ref$5.get(_key$4);
			if (_entry$8 === undefined) {
				_i$5++;
				/* continue; */ $s = 39; continue;
			}
			name$4 = _entry$8.k;
			value$3 = _entry$8.v;
			oldValue$1 = (_entry$9 = $mapIndex(prev.styles,$String.keyFor(name$4)), _entry$9 !== undefined ? _entry$9.v : "");
			/* */ if (!(value$3 === oldValue$1)) { $s = 41; continue; }
			/* */ $s = 42; continue;
			/* if (!(value$3 === oldValue$1)) { */ case 41:
				_r$10 = style.Call("setProperty", new sliceType$2([new $String(name$4), new $String(value$3)])); /* */ $s = 43; case 43: if($c) { $c = false; _r$10 = _r$10.$blk(); } if (_r$10 && _r$10.$blk !== undefined) { break s; }
				_r$10;
			/* } */ case 42:
			_i$5++;
		$s = 39; continue;
		case 40:
		_ref$6 = h.eventListeners;
		_i$6 = 0;
		/* while (true) { */ case 44:
			/* if (!(_i$6 < _ref$6.$length)) { break; } */ if(!(_i$6 < _ref$6.$length)) { $s = 45; continue; }
			l$2 = ((_i$6 < 0 || _i$6 >= _ref$6.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref$6.$array[_ref$6.$offset + _i$6]);
			_r$11 = h.node.Call("addEventListener", new sliceType$2([new $String(l$2.Name), l$2.wrapper])); /* */ $s = 46; case 46: if($c) { $c = false; _r$11 = _r$11.$blk(); } if (_r$11 && _r$11.$blk !== undefined) { break s; }
			_r$11;
			_i$6++;
		$s = 44; continue;
		case 45:
		/* */ if (!(h.innerHTML === prev.innerHTML)) { $s = 47; continue; }
		/* */ $s = 48; continue;
		/* if (!(h.innerHTML === prev.innerHTML)) { */ case 47:
			$r = h.node.Set("innerHTML", new $String(h.innerHTML)); /* */ $s = 49; case 49: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		/* } */ case 48:
		$s = -1; return;
		/* */ } return; } var $f = {$blk: HTML.ptr.prototype.reconcileProperties, $c: true, $r, _1, _entry, _entry$1, _entry$2, _entry$3, _entry$4, _entry$5, _entry$6, _entry$7, _entry$8, _entry$9, _i, _i$1, _i$2, _i$3, _i$4, _i$5, _i$6, _key, _key$1, _key$2, _key$3, _key$4, _keys, _keys$1, _keys$2, _keys$3, _keys$4, _r, _r$1, _r$10, _r$11, _r$2, _r$3, _r$4, _r$5, _r$6, _r$7, _r$8, _r$9, _ref, _ref$1, _ref$2, _ref$3, _ref$4, _ref$5, _ref$6, _size, _size$1, _size$2, _size$3, _size$4, _tuple, classList, dataset, h, l, l$1, l$2, name, name$1, name$2, name$3, name$4, ok, oldValue, oldValue$1, prev, style, value, value$1, value$2, value$3, $s};return $f;
	};
	HTML.prototype.reconcileProperties = function(prev) { return this.$val.reconcileProperties(prev); };
	HTML.ptr.prototype.removeProperties = function(prev) {
		var {_entry, _entry$1, _entry$2, _entry$3, _entry$4, _entry$5, _entry$6, _entry$7, _entry$8, _entry$9, _i, _i$1, _i$2, _i$3, _i$4, _i$5, _key, _key$1, _key$2, _key$3, _key$4, _keys, _keys$1, _keys$2, _keys$3, _keys$4, _r, _r$1, _r$2, _r$3, _r$4, _r$5, _r$6, _ref, _ref$1, _ref$2, _ref$3, _ref$4, _ref$5, _size, _size$1, _size$2, _size$3, _size$4, _tuple, _tuple$1, _tuple$2, _tuple$3, _tuple$4, classList, dataset, h, l, name, name$1, name$2, name$3, name$4, ok, ok$1, ok$2, ok$3, ok$4, prev, style, $s, $r, $c} = $restore(this, {prev});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		h = this;
		_ref = prev.properties;
		_i = 0;
		_keys = _ref ? _ref.keys() : undefined;
		_size = _ref ? _ref.size : 0;
		/* while (true) { */ case 1:
			/* if (!(_i < _size)) { break; } */ if(!(_i < _size)) { $s = 2; continue; }
			_key = _keys.next().value;
			_entry = _ref.get(_key);
			if (_entry === undefined) {
				_i++;
				/* continue; */ $s = 1; continue;
			}
			name = _entry.k;
			_tuple = (_entry$1 = $mapIndex(h.properties,$String.keyFor(name)), _entry$1 !== undefined ? [_entry$1.v, true] : [$ifaceNil, false]);
			ok = _tuple[1];
			/* */ if (!ok) { $s = 3; continue; }
			/* */ $s = 4; continue;
			/* if (!ok) { */ case 3:
				$r = h.node.Delete(name); /* */ $s = 5; case 5: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
			/* } */ case 4:
			_i++;
		$s = 1; continue;
		case 2:
		_ref$1 = prev.attributes;
		_i$1 = 0;
		_keys$1 = _ref$1 ? _ref$1.keys() : undefined;
		_size$1 = _ref$1 ? _ref$1.size : 0;
		/* while (true) { */ case 6:
			/* if (!(_i$1 < _size$1)) { break; } */ if(!(_i$1 < _size$1)) { $s = 7; continue; }
			_key$1 = _keys$1.next().value;
			_entry$2 = _ref$1.get(_key$1);
			if (_entry$2 === undefined) {
				_i$1++;
				/* continue; */ $s = 6; continue;
			}
			name$1 = _entry$2.k;
			_tuple$1 = (_entry$3 = $mapIndex(h.attributes,$String.keyFor(name$1)), _entry$3 !== undefined ? [_entry$3.v, true] : [$ifaceNil, false]);
			ok$1 = _tuple$1[1];
			/* */ if (!ok$1) { $s = 8; continue; }
			/* */ $s = 9; continue;
			/* if (!ok$1) { */ case 8:
				_r = h.node.Call("removeAttribute", new sliceType$2([new $String(name$1)])); /* */ $s = 10; case 10: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
				_r;
			/* } */ case 9:
			_i$1++;
		$s = 6; continue;
		case 7:
		_r$1 = h.node.Get("classList"); /* */ $s = 11; case 11: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
		classList = _r$1;
		_ref$2 = prev.classes;
		_i$2 = 0;
		_keys$2 = _ref$2 ? _ref$2.keys() : undefined;
		_size$2 = _ref$2 ? _ref$2.size : 0;
		/* while (true) { */ case 12:
			/* if (!(_i$2 < _size$2)) { break; } */ if(!(_i$2 < _size$2)) { $s = 13; continue; }
			_key$2 = _keys$2.next().value;
			_entry$4 = _ref$2.get(_key$2);
			if (_entry$4 === undefined) {
				_i$2++;
				/* continue; */ $s = 12; continue;
			}
			name$2 = _entry$4.k;
			_tuple$2 = (_entry$5 = $mapIndex(h.classes,$String.keyFor(name$2)), _entry$5 !== undefined ? [_entry$5.v, true] : [new structType.ptr(), false]);
			ok$2 = _tuple$2[1];
			/* */ if (!ok$2) { $s = 14; continue; }
			/* */ $s = 15; continue;
			/* if (!ok$2) { */ case 14:
				_r$2 = classList.Call("remove", new sliceType$2([new $String(name$2)])); /* */ $s = 16; case 16: if($c) { $c = false; _r$2 = _r$2.$blk(); } if (_r$2 && _r$2.$blk !== undefined) { break s; }
				_r$2;
			/* } */ case 15:
			_i$2++;
		$s = 12; continue;
		case 13:
		_r$3 = h.node.Get("dataset"); /* */ $s = 17; case 17: if($c) { $c = false; _r$3 = _r$3.$blk(); } if (_r$3 && _r$3.$blk !== undefined) { break s; }
		dataset = _r$3;
		_ref$3 = prev.dataset;
		_i$3 = 0;
		_keys$3 = _ref$3 ? _ref$3.keys() : undefined;
		_size$3 = _ref$3 ? _ref$3.size : 0;
		/* while (true) { */ case 18:
			/* if (!(_i$3 < _size$3)) { break; } */ if(!(_i$3 < _size$3)) { $s = 19; continue; }
			_key$3 = _keys$3.next().value;
			_entry$6 = _ref$3.get(_key$3);
			if (_entry$6 === undefined) {
				_i$3++;
				/* continue; */ $s = 18; continue;
			}
			name$3 = _entry$6.k;
			_tuple$3 = (_entry$7 = $mapIndex(h.dataset,$String.keyFor(name$3)), _entry$7 !== undefined ? [_entry$7.v, true] : ["", false]);
			ok$3 = _tuple$3[1];
			/* */ if (!ok$3) { $s = 20; continue; }
			/* */ $s = 21; continue;
			/* if (!ok$3) { */ case 20:
				$r = dataset.Delete(name$3); /* */ $s = 22; case 22: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
			/* } */ case 21:
			_i$3++;
		$s = 18; continue;
		case 19:
		_r$4 = h.node.Get("style"); /* */ $s = 23; case 23: if($c) { $c = false; _r$4 = _r$4.$blk(); } if (_r$4 && _r$4.$blk !== undefined) { break s; }
		style = _r$4;
		_ref$4 = prev.styles;
		_i$4 = 0;
		_keys$4 = _ref$4 ? _ref$4.keys() : undefined;
		_size$4 = _ref$4 ? _ref$4.size : 0;
		/* while (true) { */ case 24:
			/* if (!(_i$4 < _size$4)) { break; } */ if(!(_i$4 < _size$4)) { $s = 25; continue; }
			_key$4 = _keys$4.next().value;
			_entry$8 = _ref$4.get(_key$4);
			if (_entry$8 === undefined) {
				_i$4++;
				/* continue; */ $s = 24; continue;
			}
			name$4 = _entry$8.k;
			_tuple$4 = (_entry$9 = $mapIndex(h.styles,$String.keyFor(name$4)), _entry$9 !== undefined ? [_entry$9.v, true] : ["", false]);
			ok$4 = _tuple$4[1];
			/* */ if (!ok$4) { $s = 26; continue; }
			/* */ $s = 27; continue;
			/* if (!ok$4) { */ case 26:
				_r$5 = style.Call("removeProperty", new sliceType$2([new $String(name$4)])); /* */ $s = 28; case 28: if($c) { $c = false; _r$5 = _r$5.$blk(); } if (_r$5 && _r$5.$blk !== undefined) { break s; }
				_r$5;
			/* } */ case 27:
			_i$4++;
		$s = 24; continue;
		case 25:
		_ref$5 = prev.eventListeners;
		_i$5 = 0;
		/* while (true) { */ case 29:
			/* if (!(_i$5 < _ref$5.$length)) { break; } */ if(!(_i$5 < _ref$5.$length)) { $s = 30; continue; }
			l = ((_i$5 < 0 || _i$5 >= _ref$5.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref$5.$array[_ref$5.$offset + _i$5]);
			_r$6 = h.node.Call("removeEventListener", new sliceType$2([new $String(l.Name), l.wrapper])); /* */ $s = 31; case 31: if($c) { $c = false; _r$6 = _r$6.$blk(); } if (_r$6 && _r$6.$blk !== undefined) { break s; }
			_r$6;
			$r = l.wrapper.Release(); /* */ $s = 32; case 32: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
			_i$5++;
		$s = 29; continue;
		case 30:
		$s = -1; return;
		/* */ } return; } var $f = {$blk: HTML.ptr.prototype.removeProperties, $c: true, $r, _entry, _entry$1, _entry$2, _entry$3, _entry$4, _entry$5, _entry$6, _entry$7, _entry$8, _entry$9, _i, _i$1, _i$2, _i$3, _i$4, _i$5, _key, _key$1, _key$2, _key$3, _key$4, _keys, _keys$1, _keys$2, _keys$3, _keys$4, _r, _r$1, _r$2, _r$3, _r$4, _r$5, _r$6, _ref, _ref$1, _ref$2, _ref$3, _ref$4, _ref$5, _size, _size$1, _size$2, _size$3, _size$4, _tuple, _tuple$1, _tuple$2, _tuple$3, _tuple$4, classList, dataset, h, l, name, name$1, name$2, name$3, name$4, ok, ok$1, ok$2, ok$3, ok$4, prev, style, $s};return $f;
	};
	HTML.prototype.removeProperties = function(prev) { return this.$val.removeProperties(prev); };
	HTML.ptr.prototype.reconcileChildren = function(prev) {
		var {_arg, _arg$1, _arg$2, _arg$3, _entry, _entry$1, _entry$2, _i, _i$1, _key, _key$1, _key$2, _keys, _r, _r$1, _r$10, _r$11, _r$12, _r$13, _r$14, _r$2, _r$3, _r$4, _r$5, _r$6, _r$7, _r$8, _r$9, _ref, _ref$1, _ref$2, _size, _tuple, _tuple$1, _tuple$10, _tuple$11, _tuple$12, _tuple$2, _tuple$3, _tuple$4, _tuple$5, _tuple$6, _tuple$7, _tuple$8, _tuple$9, _v, _v$1, _v$2, _v$3, c, exists, h, hasKeyedChildren, i, i$1, insertBeforeKeyedNode, isKeyer, isList, keyer, m, m$1, m$2, mounters, mounters$1, new$1, nextChild, nextChildComponent, nextChildList, nextChildList$1, nextChildRender, nextChildRender$1, nextKey, ok, ok$1, ok$2, ok$3, ok$4, ok$5, ok$6, ok$7, pendingMounts, prev, prevChild, prevChildComponent, prevChildList, prevChildRender, prevChildren, prevHadKeyedChildren, prevKeyedChild, skip, skip$1, stableKey, v, v$1, x, x$1, x$2, x$3, x$4, $s, $r, $c} = $restore(this, {prev});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		pendingMounts = sliceType$4.nil;
		h = this;
		hasKeyedChildren = (h.keyedChildren ? h.keyedChildren.size : 0) > 0;
		prevHadKeyedChildren = (prev.keyedChildren ? prev.keyedChildren.size : 0) > 0;
		_ref = h.children;
		_i = 0;
		/* while (true) { */ case 1:
			/* if (!(_i < _ref.$length)) { break; } */ if(!(_i < _ref.$length)) { $s = 2; continue; }
			i = _i;
			nextChild = ((_i < 0 || _i >= _ref.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref.$array[_ref.$offset + _i]);
			_ref$1 = nextChild;
			if ($assertType(_ref$1, ptrType, true)[1]) {
				v = _ref$1.$val;
				if (v === ptrType.nil) {
					nextChild = $ifaceNil;
					(x = h.children, ((i < 0 || i >= x.$length) ? ($throwRuntimeError("index out of range"), undefined) : x.$array[x.$offset + i] = nextChild));
				}
			} else if ($assertType(_ref$1, List, true)[1]) {
				v$1 = _ref$1.$val;
				nextChild = (x$1 = new KeyedList.ptr(new HTML.ptr($ifaceNil, "", "", "", "", false, false, false, false, false, sliceType$5.nil, $convertSliceType(v$1, sliceType$6), $ifaceNil, false, $ifaceNil, ptrType.nil), $ifaceNil), new x$1.constructor.elem(x$1));
				(x$2 = h.children, ((i < 0 || i >= x$2.$length) ? ($throwRuntimeError("index out of range"), undefined) : x$2.$array[x$2.$offset + i] = nextChild));
			}
			_r = h.node.Equal(prev.node); /* */ $s = 3; case 3: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
			new$1 = !_r;
			nextKey = $ifaceNil;
			_tuple = $assertType(nextChild, Keyer, true);
			keyer = _tuple[0];
			isKeyer = _tuple[1];
			if (hasKeyedChildren && !isKeyer) {
				$panic(new $String("vecty: all siblings must have keys when using keyed elements"));
			}
			/* */ if (isKeyer) { $s = 4; continue; }
			/* */ $s = 5; continue;
			/* if (isKeyer) { */ case 4:
				_r$1 = keyer.Key(); /* */ $s = 6; case 6: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
				nextKey = _r$1;
				if (hasKeyedChildren && $interfaceIsEqual(nextKey, $ifaceNil)) {
					$panic(new $String("vecty: all siblings must have keys when using keyed elements"));
				}
				if (!($interfaceIsEqual(nextKey, $ifaceNil))) {
					if (h.keyedChildren === false) {
						h.keyedChildren = new $global.Map();
					}
					_tuple$1 = (_entry = $mapIndex(h.keyedChildren,$emptyInterface.keyFor(nextKey)), _entry !== undefined ? [_entry.v, true] : [$ifaceNil, false]);
					exists = _tuple$1[1];
					if (exists) {
						$panic(new $String("vecty: duplicate sibling key"));
					}
					_key = nextKey; (h.keyedChildren || $throwRuntimeError("assignment to entry in nil map")).set($emptyInterface.keyFor(_key), { k: _key, v: nextChild });
					hasKeyedChildren = true;
				}
			/* } */ case 5:
			/* */ if ((i >= prev.children.$length && !hasKeyedChildren) || new$1) { $s = 7; continue; }
			/* */ $s = 8; continue;
			/* if ((i >= prev.children.$length && !hasKeyedChildren) || new$1) { */ case 7:
				_tuple$2 = $assertType(nextChild, KeyedList, true);
				nextChildList = $clone(_tuple$2[0], KeyedList);
				ok = _tuple$2[1];
				/* */ if (ok) { $s = 9; continue; }
				/* */ $s = 10; continue;
				/* if (ok) { */ case 9:
					_arg = pendingMounts;
					_r$2 = $clone(nextChildList, KeyedList).reconcile(h, $ifaceNil); /* */ $s = 11; case 11: if($c) { $c = false; _r$2 = _r$2.$blk(); } if (_r$2 && _r$2.$blk !== undefined) { break s; }
					_arg$1 = _r$2;
					pendingMounts = $appendSlice(_arg, _arg$1);
					_i++;
					/* continue; */ $s = 1; continue;
				/* } */ case 10:
				_r$3 = render(nextChild, $ifaceNil); /* */ $s = 12; case 12: if($c) { $c = false; _r$3 = _r$3.$blk(); } if (_r$3 && _r$3.$blk !== undefined) { break s; }
				_tuple$3 = _r$3;
				nextChildRender = _tuple$3[0];
				skip = _tuple$3[1];
				mounters = _tuple$3[2];
				if (skip || nextChildRender === ptrType.nil) {
					_i++;
					/* continue; */ $s = 1; continue;
				}
				pendingMounts = $appendSlice(pendingMounts, mounters);
				_tuple$4 = $assertType(nextChild, Mounter, true);
				m = _tuple$4[0];
				ok$1 = _tuple$4[1];
				if (ok$1) {
					pendingMounts = $append(pendingMounts, m);
				}
				h.lastRenderedChild = nextChildRender;
				$r = h.insertBefore(h.insertBeforeNode, nextChildRender); /* */ $s = 13; case 13: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
				_i++;
				/* continue; */ $s = 1; continue;
			/* } */ case 8:
			prevChild = $ifaceNil;
			if (prev.children.$length > i) {
				prevChild = (x$3 = prev.children, ((i < 0 || i >= x$3.$length) ? ($throwRuntimeError("index out of range"), undefined) : x$3.$array[x$3.$offset + i]));
			}
			if (hasKeyedChildren) {
				_tuple$5 = (_entry$1 = $mapIndex(prev.keyedChildren,$emptyInterface.keyFor(nextKey)), _entry$1 !== undefined ? [_entry$1.v, true] : [$ifaceNil, false]);
				prevKeyedChild = _tuple$5[0];
				ok$2 = _tuple$5[1];
				if (ok$2) {
					prevChild = prevKeyedChild;
				} else {
					prevChild = $ifaceNil;
				}
			}
			prevChildRender = ptrType.nil;
			_tuple$6 = $assertType(prevChild, KeyedList, true);
			isList = _tuple$6[1];
			/* */ if (!isList) { $s = 14; continue; }
			/* */ $s = 15; continue;
			/* if (!isList) { */ case 14:
				_r$4 = extractHTML(prevChild); /* */ $s = 16; case 16: if($c) { $c = false; _r$4 = _r$4.$blk(); } if (_r$4 && _r$4.$blk !== undefined) { break s; }
				prevChildRender = _r$4;
			/* } */ case 15:
			/* */ if (prevChildRender === ptrType.nil && $interfaceIsEqual(h.insertBeforeNode, $ifaceNil)) { $s = 17; continue; }
			/* */ $s = 18; continue;
			/* if (prevChildRender === ptrType.nil && $interfaceIsEqual(h.insertBeforeNode, $ifaceNil)) { */ case 17:
				/* */ if (h.lastRenderedChild === ptrType.nil) { $s = 19; continue; }
				/* */ $s = 20; continue;
				/* if (h.lastRenderedChild === ptrType.nil) { */ case 19:
					_r$5 = h.firstChild(); /* */ $s = 22; case 22: if($c) { $c = false; _r$5 = _r$5.$blk(); } if (_r$5 && _r$5.$blk !== undefined) { break s; }
					h.insertBeforeNode = _r$5;
					$s = 21; continue;
				/* } else { */ case 20:
					_r$6 = h.lastRenderedChild.nextSibling(); /* */ $s = 23; case 23: if($c) { $c = false; _r$6 = _r$6.$blk(); } if (_r$6 && _r$6.$blk !== undefined) { break s; }
					h.insertBeforeNode = _r$6;
				/* } */ case 21:
			/* } */ case 18:
			if (!(!(prevChildRender === ptrType.nil))) { _v = false; $s = 26; continue s; }
			_r$7 = prevChildRender.node.Equal(h.insertBeforeNode); /* */ $s = 27; case 27: if($c) { $c = false; _r$7 = _r$7.$blk(); } if (_r$7 && _r$7.$blk !== undefined) { break s; }
			_v = _r$7; case 26:
			/* */ if (_v) { $s = 24; continue; }
			/* */ $s = 25; continue;
			/* if (_v) { */ case 24:
				_r$8 = h.insertBeforeNode.Get("nextSibling"); /* */ $s = 28; case 28: if($c) { $c = false; _r$8 = _r$8.$blk(); } if (_r$8 && _r$8.$blk !== undefined) { break s; }
				h.insertBeforeNode = _r$8;
			/* } */ case 25:
			_tuple$7 = $assertType(nextChild, KeyedList, true);
			nextChildList$1 = $clone(_tuple$7[0], KeyedList);
			ok$3 = _tuple$7[1];
			/* */ if (ok$3) { $s = 29; continue; }
			/* */ $s = 30; continue;
			/* if (ok$3) { */ case 29:
				_arg$2 = pendingMounts;
				_r$9 = $clone(nextChildList$1, KeyedList).reconcile(h, prevChild); /* */ $s = 31; case 31: if($c) { $c = false; _r$9 = _r$9.$blk(); } if (_r$9 && _r$9.$blk !== undefined) { break s; }
				_arg$3 = _r$9;
				pendingMounts = $appendSlice(_arg$2, _arg$3);
				_i++;
				/* continue; */ $s = 1; continue;
			/* } */ case 30:
			_tuple$8 = $assertType(prevChild, KeyedList, true);
			prevChildList = $clone(_tuple$8[0], KeyedList);
			ok$4 = _tuple$8[1];
			/* */ if (ok$4) { $s = 32; continue; }
			/* */ $s = 33; continue;
			/* if (ok$4) { */ case 32:
				$r = $clone(prevChildList, KeyedList).remove(h); /* */ $s = 34; case 34: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
				prevChild = $ifaceNil;
			/* } */ case 33:
			insertBeforeKeyedNode = $ifaceNil;
			stableKey = false;
			/* */ if (hasKeyedChildren) { $s = 35; continue; }
			/* */ $s = 36; continue;
			/* if (hasKeyedChildren) { */ case 35:
				_r$10 = h.lastRenderedChild.nextSibling(); /* */ $s = 37; case 37: if($c) { $c = false; _r$10 = _r$10.$blk(); } if (_r$10 && _r$10.$blk !== undefined) { break s; }
				insertBeforeKeyedNode = _r$10;
				if (!(!(prevChildRender === ptrType.nil))) { _v$1 = false; $s = 40; continue s; }
				_r$11 = prevChildRender.node.Equal(insertBeforeKeyedNode); /* */ $s = 41; case 41: if($c) { $c = false; _r$11 = _r$11.$blk(); } if (_r$11 && _r$11.$blk !== undefined) { break s; }
				_v$1 = _r$11; case 40:
				/* */ if (_v$1) { $s = 38; continue; }
				/* */ $s = 39; continue;
				/* if (_v$1) { */ case 38:
					stableKey = true;
					insertBeforeKeyedNode = $ifaceNil;
				/* } */ case 39:
			/* } */ case 36:
			_r$12 = render(nextChild, prevChild); /* */ $s = 42; case 42: if($c) { $c = false; _r$12 = _r$12.$blk(); } if (_r$12 && _r$12.$blk !== undefined) { break s; }
			_tuple$9 = _r$12;
			nextChildRender$1 = _tuple$9[0];
			skip$1 = _tuple$9[1];
			mounters$1 = _tuple$9[2];
			if (!(nextChildRender$1 === ptrType.nil) && !(prevChildRender === ptrType.nil) && nextChildRender$1 === prevChildRender) {
				$panic(new $String("vecty: next child render must not equal previous child render (did the child Render illegally return a stored render variable?)"));
			}
			if (!(nextChildRender$1 === ptrType.nil)) {
				h.lastRenderedChild = nextChildRender$1;
			}
			_tuple$10 = $assertType(prevChild, Component, true);
			prevChildComponent = _tuple$10[0];
			ok$5 = _tuple$10[1];
			if (ok$5) {
				_tuple$11 = $assertType(nextChild, Component, true);
				nextChildComponent = _tuple$11[0];
				ok$6 = _tuple$11[1];
				if (ok$6 && sameType(prevChildComponent, nextChildComponent)) {
					(x$4 = h.children, ((i < 0 || i >= x$4.$length) ? ($throwRuntimeError("index out of range"), undefined) : x$4.$array[x$4.$offset + i] = prevChild));
					nextChild = prevChild;
					if (hasKeyedChildren) {
						_key$1 = nextKey; (h.keyedChildren || $throwRuntimeError("assignment to entry in nil map")).set($emptyInterface.keyFor(_key$1), { k: _key$1, v: prevChild });
					}
				}
			}
			if (skip$1) {
				_i++;
				/* continue; */ $s = 1; continue;
			}
			pendingMounts = $appendSlice(pendingMounts, mounters$1);
				/* */ if (nextChildRender$1 === ptrType.nil && prevChildRender === ptrType.nil) { $s = 44; continue; }
				/* */ if (!(nextChildRender$1 === ptrType.nil) && !(prevChildRender === ptrType.nil)) { $s = 45; continue; }
				/* */ if (nextChildRender$1 === ptrType.nil && !(prevChildRender === ptrType.nil)) { $s = 46; continue; }
				/* */ if (!(nextChildRender$1 === ptrType.nil) && prevChildRender === ptrType.nil) { $s = 47; continue; }
				/* */ $s = 48; continue;
				/* if (nextChildRender$1 === ptrType.nil && prevChildRender === ptrType.nil) { */ case 44:
					_i++;
					/* continue; */ $s = 1; continue;
					$s = 49; continue;
				/* } else if (!(nextChildRender$1 === ptrType.nil) && !(prevChildRender === ptrType.nil)) { */ case 45:
					_r$13 = mountUnmount(nextChild, prevChild); /* */ $s = 50; case 50: if($c) { $c = false; _r$13 = _r$13.$blk(); } if (_r$13 && _r$13.$blk !== undefined) { break s; }
					m$1 = _r$13;
					if (!($interfaceIsEqual(m$1, $ifaceNil))) {
						pendingMounts = $append(pendingMounts, m$1);
					}
					if (!(hasKeyedChildren)) { _v$2 = false; $s = 53; continue s; }
					if (!(!(prevChildRender === ptrType.nil))) { _v$3 = false; $s = 54; continue s; }
					_r$14 = prevChildRender.node.Equal(nextChildRender$1.node); /* */ $s = 55; case 55: if($c) { $c = false; _r$14 = _r$14.$blk(); } if (_r$14 && _r$14.$blk !== undefined) { break s; }
					_v$3 = _r$14; case 54:
					_v$2 = _v$3; case 53:
					/* */ if (_v$2) { $s = 51; continue; }
					/* */ $s = 52; continue;
					/* if (_v$2) { */ case 51:
						$mapDelete(prev.keyedChildren, $emptyInterface.keyFor(nextKey));
					/* } */ case 52:
					/* */ if (!hasKeyedChildren || stableKey) { $s = 56; continue; }
					/* */ $s = 57; continue;
					/* if (!hasKeyedChildren || stableKey) { */ case 56:
						$r = replaceNode(nextChildRender$1.node, prevChildRender.node); /* */ $s = 58; case 58: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
						_i++;
						/* continue; */ $s = 1; continue;
					/* } */ case 57:
					/* */ if (!($interfaceIsEqual(insertBeforeKeyedNode, $ifaceNil))) { $s = 59; continue; }
					/* */ $s = 60; continue;
					/* if (!($interfaceIsEqual(insertBeforeKeyedNode, $ifaceNil))) { */ case 59:
						$r = h.insertBefore(insertBeforeKeyedNode, nextChildRender$1); /* */ $s = 61; case 61: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
						_i++;
						/* continue; */ $s = 1; continue;
					/* } */ case 60:
					$r = h.insertBefore(h.insertBeforeNode, nextChildRender$1); /* */ $s = 62; case 62: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
					$s = 49; continue;
				/* } else if (nextChildRender$1 === ptrType.nil && !(prevChildRender === ptrType.nil)) { */ case 46:
					$r = h.removeChild(prevChildRender); /* */ $s = 63; case 63: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
					$s = 49; continue;
				/* } else if (!(nextChildRender$1 === ptrType.nil) && prevChildRender === ptrType.nil) { */ case 47:
					_tuple$12 = $assertType(nextChild, Mounter, true);
					m$2 = _tuple$12[0];
					ok$7 = _tuple$12[1];
					if (ok$7) {
						pendingMounts = $append(pendingMounts, m$2);
					}
					/* */ if (!($interfaceIsEqual(insertBeforeKeyedNode, $ifaceNil))) { $s = 64; continue; }
					/* */ $s = 65; continue;
					/* if (!($interfaceIsEqual(insertBeforeKeyedNode, $ifaceNil))) { */ case 64:
						$r = h.insertBefore(insertBeforeKeyedNode, nextChildRender$1); /* */ $s = 66; case 66: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
						_i++;
						/* continue; */ $s = 1; continue;
					/* } */ case 65:
					$r = h.insertBefore(h.insertBeforeNode, nextChildRender$1); /* */ $s = 67; case 67: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
					$s = 49; continue;
				/* } else { */ case 48:
					$panic(new $String("vecty: internal error (unexpected switch state)"));
				/* } */ case 49:
			case 43:
			_i++;
		$s = 1; continue;
		case 2:
		/* */ if (prevHadKeyedChildren && hasKeyedChildren) { $s = 68; continue; }
		/* */ $s = 69; continue;
		/* if (prevHadKeyedChildren && hasKeyedChildren) { */ case 68:
			prevChildren = $makeSlice(sliceType$6, (prev.keyedChildren ? prev.keyedChildren.size : 0));
			i$1 = 0;
			_ref$2 = prev.keyedChildren;
			_i$1 = 0;
			_keys = _ref$2 ? _ref$2.keys() : undefined;
			_size = _ref$2 ? _ref$2.size : 0;
			while (true) {
				if (!(_i$1 < _size)) { break; }
				_key$2 = _keys.next().value;
				_entry$2 = _ref$2.get(_key$2);
				if (_entry$2 === undefined) {
					_i$1++;
					continue;
				}
				c = _entry$2.v;
				((i$1 < 0 || i$1 >= prevChildren.$length) ? ($throwRuntimeError("index out of range"), undefined) : prevChildren.$array[prevChildren.$offset + i$1] = c);
				i$1 = i$1 + (1) >> 0;
				_i$1++;
			}
			$r = h.removeChildren(prevChildren); /* */ $s = 70; case 70: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
			pendingMounts = pendingMounts;
			$s = -1; return pendingMounts;
		/* } */ case 69:
		/* */ if (prev.children.$length > h.children.$length) { $s = 71; continue; }
		/* */ $s = 72; continue;
		/* if (prev.children.$length > h.children.$length) { */ case 71:
			$r = h.removeChildren($subslice(prev.children, h.children.$length)); /* */ $s = 73; case 73: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		/* } */ case 72:
		pendingMounts = pendingMounts;
		$s = -1; return pendingMounts;
		/* */ } return; } var $f = {$blk: HTML.ptr.prototype.reconcileChildren, $c: true, $r, _arg, _arg$1, _arg$2, _arg$3, _entry, _entry$1, _entry$2, _i, _i$1, _key, _key$1, _key$2, _keys, _r, _r$1, _r$10, _r$11, _r$12, _r$13, _r$14, _r$2, _r$3, _r$4, _r$5, _r$6, _r$7, _r$8, _r$9, _ref, _ref$1, _ref$2, _size, _tuple, _tuple$1, _tuple$10, _tuple$11, _tuple$12, _tuple$2, _tuple$3, _tuple$4, _tuple$5, _tuple$6, _tuple$7, _tuple$8, _tuple$9, _v, _v$1, _v$2, _v$3, c, exists, h, hasKeyedChildren, i, i$1, insertBeforeKeyedNode, isKeyer, isList, keyer, m, m$1, m$2, mounters, mounters$1, new$1, nextChild, nextChildComponent, nextChildList, nextChildList$1, nextChildRender, nextChildRender$1, nextKey, ok, ok$1, ok$2, ok$3, ok$4, ok$5, ok$6, ok$7, pendingMounts, prev, prevChild, prevChildComponent, prevChildList, prevChildRender, prevChildren, prevHadKeyedChildren, prevKeyedChild, skip, skip$1, stableKey, v, v$1, x, x$1, x$2, x$3, x$4, $s};return $f;
	};
	HTML.prototype.reconcileChildren = function(prev) { return this.$val.reconcileChildren(prev); };
	HTML.ptr.prototype.removeChildren = function(prevChildren) {
		var {_i, _r, _ref, _tuple, h, ok, prevChild, prevChildList, prevChildRender, prevChildren, $s, $r, $c} = $restore(this, {prevChildren});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		h = this;
		_ref = prevChildren;
		_i = 0;
		/* while (true) { */ case 1:
			/* if (!(_i < _ref.$length)) { break; } */ if(!(_i < _ref.$length)) { $s = 2; continue; }
			prevChild = ((_i < 0 || _i >= _ref.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref.$array[_ref.$offset + _i]);
			_tuple = $assertType(prevChild, KeyedList, true);
			prevChildList = $clone(_tuple[0], KeyedList);
			ok = _tuple[1];
			/* */ if (ok) { $s = 3; continue; }
			/* */ $s = 4; continue;
			/* if (ok) { */ case 3:
				$r = $clone(prevChildList, KeyedList).remove(h); /* */ $s = 5; case 5: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
				_i++;
				/* continue; */ $s = 1; continue;
			/* } */ case 4:
			_r = extractHTML(prevChild); /* */ $s = 6; case 6: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
			prevChildRender = _r;
			if (prevChildRender === ptrType.nil) {
				_i++;
				/* continue; */ $s = 1; continue;
			}
			$r = h.removeChild(prevChildRender); /* */ $s = 7; case 7: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
			_i++;
		$s = 1; continue;
		case 2:
		$s = -1; return;
		/* */ } return; } var $f = {$blk: HTML.ptr.prototype.removeChildren, $c: true, $r, _i, _r, _ref, _tuple, h, ok, prevChild, prevChildList, prevChildRender, prevChildren, $s};return $f;
	};
	HTML.prototype.removeChildren = function(prevChildren) { return this.$val.removeChildren(prevChildren); };
	HTML.ptr.prototype.firstChild = function() {
		var {$24r, _r, h, $s, $r, $c} = $restore(this, {});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		h = this;
		if (h === ptrType.nil || $interfaceIsEqual(h.node, $ifaceNil)) {
			$s = -1; return $ifaceNil;
		}
		_r = h.node.Get("firstChild"); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		$24r = _r;
		$s = 2; case 2: return $24r;
		/* */ } return; } var $f = {$blk: HTML.ptr.prototype.firstChild, $c: true, $r, $24r, _r, h, $s};return $f;
	};
	HTML.prototype.firstChild = function() { return this.$val.firstChild(); };
	HTML.ptr.prototype.nextSibling = function() {
		var {$24r, _r, h, $s, $r, $c} = $restore(this, {});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		h = this;
		if (h === ptrType.nil || $interfaceIsEqual(h.node, $ifaceNil)) {
			$s = -1; return $ifaceNil;
		}
		_r = h.node.Get("nextSibling"); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		$24r = _r;
		$s = 2; case 2: return $24r;
		/* */ } return; } var $f = {$blk: HTML.ptr.prototype.nextSibling, $c: true, $r, $24r, _r, h, $s};return $f;
	};
	HTML.prototype.nextSibling = function() { return this.$val.nextSibling(); };
	HTML.ptr.prototype.removeChild = function(child) {
		var {_r, _r$1, _r$2, _r$3, _v, child, h, $s, $r, $c} = $restore(this, {child});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		h = this;
		if (!(!($interfaceIsEqual(h.insertBeforeNode, $ifaceNil)))) { _v = false; $s = 3; continue s; }
		_r = h.insertBeforeNode.Equal(child.node); /* */ $s = 4; case 4: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		_v = _r; case 3:
		/* */ if (_v) { $s = 1; continue; }
		/* */ $s = 2; continue;
		/* if (_v) { */ case 1:
			_r$1 = h.insertBeforeNode.Get("nextSibling"); /* */ $s = 5; case 5: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
			h.insertBeforeNode = _r$1;
		/* } */ case 2:
		$r = unmount(child); /* */ $s = 6; case 6: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		if ($interfaceIsEqual(child.node, $ifaceNil)) {
			$s = -1; return;
		}
		_r$2 = child.node.Get("parentNode"); /* */ $s = 7; case 7: if($c) { $c = false; _r$2 = _r$2.$blk(); } if (_r$2 && _r$2.$blk !== undefined) { break s; }
		_r$3 = _r$2.Call("removeChild", new sliceType$2([child.node])); /* */ $s = 8; case 8: if($c) { $c = false; _r$3 = _r$3.$blk(); } if (_r$3 && _r$3.$blk !== undefined) { break s; }
		_r$3;
		$s = -1; return;
		/* */ } return; } var $f = {$blk: HTML.ptr.prototype.removeChild, $c: true, $r, _r, _r$1, _r$2, _r$3, _v, child, h, $s};return $f;
	};
	HTML.prototype.removeChild = function(child) { return this.$val.removeChild(child); };
	HTML.ptr.prototype.appendChild = function(child) {
		var {_r, child, h, $s, $r, $c} = $restore(this, {child});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		h = this;
		_r = h.node.Call("appendChild", new sliceType$2([child.node])); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		_r;
		$s = -1; return;
		/* */ } return; } var $f = {$blk: HTML.ptr.prototype.appendChild, $c: true, $r, _r, child, h, $s};return $f;
	};
	HTML.prototype.appendChild = function(child) { return this.$val.appendChild(child); };
	HTML.ptr.prototype.insertBefore = function(node, child) {
		var {_r, child, h, node, $s, $r, $c} = $restore(this, {node, child});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		h = this;
		/* */ if ($interfaceIsEqual(node, $ifaceNil)) { $s = 1; continue; }
		/* */ $s = 2; continue;
		/* if ($interfaceIsEqual(node, $ifaceNil)) { */ case 1:
			$r = h.appendChild(child); /* */ $s = 3; case 3: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
			$s = -1; return;
		/* } */ case 2:
		_r = h.node.Call("insertBefore", new sliceType$2([child.node, node])); /* */ $s = 4; case 4: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		_r;
		$s = -1; return;
		/* */ } return; } var $f = {$blk: HTML.ptr.prototype.insertBefore, $c: true, $r, _r, child, h, node, $s};return $f;
	};
	HTML.prototype.insertBefore = function(node, child) { return this.$val.insertBefore(node, child); };
	List.prototype.WithKey = function(key) {
		var key, l;
		l = this;
		return new KeyedList.ptr(new HTML.ptr($ifaceNil, "", "", "", "", false, false, false, false, false, sliceType$5.nil, $convertSliceType(l, sliceType$6), $ifaceNil, false, $ifaceNil, ptrType.nil), key);
	};
	$ptrType(List).prototype.WithKey = function(key) { return this.$get().WithKey(key); };
	KeyedList.ptr.prototype.Key = function() {
		var l;
		l = this;
		return l.key;
	};
	KeyedList.prototype.Key = function() { return this.$val.Key(); };
	KeyedList.ptr.prototype.reconcile = function(parent, prevChild) {
		var {_r, _r$1, _r$2, _r$3, _r$4, _r$5, _ref, _tuple, _v, keyer, l, ok, parent, pendingMounts, prev, prevChild, v, v$1, v$2, $s, $r, $c} = $restore(this, {parent, prevChild});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		pendingMounts = sliceType$4.nil;
		l = this;
		l.html.node = parent.node;
		l.html.insertBeforeNode = parent.insertBeforeNode;
		l.html.lastRenderedChild = parent.lastRenderedChild;
		_ref = prevChild;
		/* */ if ($assertType(_ref, KeyedList, true)[1]) { $s = 1; continue; }
		/* */ if ($assertType(_ref, ptrType, true)[1] || $assertType(_ref, Component, true)[1] || _ref === $ifaceNil) { $s = 2; continue; }
		/* */ $s = 3; continue;
		/* if ($assertType(_ref, KeyedList, true)[1]) { */ case 1:
			v = $clone(_ref.$val, KeyedList);
			_r = l.html.reconcileChildren(v.html); /* */ $s = 5; case 5: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
			pendingMounts = _r;
			$s = 4; continue;
		/* } else if ($assertType(_ref, ptrType, true)[1] || $assertType(_ref, Component, true)[1] || _ref === $ifaceNil) { */ case 2:
			v$1 = _ref;
			/* */ if ($interfaceIsEqual(v$1, $ifaceNil)) { $s = 6; continue; }
			/* */ $s = 7; continue;
			/* if ($interfaceIsEqual(v$1, $ifaceNil)) { */ case 6:
				_r$1 = l.html.reconcileChildren(new HTML.ptr(parent.node, "", "", "", "", false, false, false, false, false, sliceType$5.nil, sliceType$6.nil, $ifaceNil, false, $ifaceNil, ptrType.nil)); /* */ $s = 9; case 9: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
				pendingMounts = _r$1;
				$s = 8; continue;
			/* } else { */ case 7:
				prev = new HTML.ptr(parent.node, "", "", "", "", false, false, false, false, false, sliceType$5.nil, new sliceType$6([prevChild]), $ifaceNil, false, $ifaceNil, ptrType.nil);
				_tuple = $assertType(prevChild, Keyer, true);
				keyer = _tuple[0];
				ok = _tuple[1];
				if (!(ok)) { _v = false; $s = 12; continue s; }
				_r$2 = keyer.Key(); /* */ $s = 13; case 13: if($c) { $c = false; _r$2 = _r$2.$blk(); } if (_r$2 && _r$2.$blk !== undefined) { break s; }
				_v = !($interfaceIsEqual(_r$2, $ifaceNil)); case 12:
				/* */ if (_v) { $s = 10; continue; }
				/* */ $s = 11; continue;
				/* if (_v) { */ case 10:
					_r$3 = keyer.Key(); /* */ $s = 14; case 14: if($c) { $c = false; _r$3 = _r$3.$blk(); } if (_r$3 && _r$3.$blk !== undefined) { break s; }
					prev.keyedChildren = $makeMap($emptyInterface.keyFor, [{ k: _r$3, v: prevChild }]);
				/* } */ case 11:
				_r$4 = l.html.reconcileChildren(prev); /* */ $s = 15; case 15: if($c) { $c = false; _r$4 = _r$4.$blk(); } if (_r$4 && _r$4.$blk !== undefined) { break s; }
				pendingMounts = _r$4;
			/* } */ case 8:
			$s = 4; continue;
		/* } else { */ case 3:
			v$2 = _ref;
			_r$5 = reflect.TypeOf(v$2).String(); /* */ $s = 16; case 16: if($c) { $c = false; _r$5 = _r$5.$blk(); } if (_r$5 && _r$5.$blk !== undefined) { break s; }
			$panic(new $String("vecty: internal error (unexpected ComponentOrHTML type " + _r$5 + ")"));
		/* } */ case 4:
		if (!($interfaceIsEqual(parent.insertBeforeNode, $ifaceNil))) {
			parent.insertBeforeNode = l.html.insertBeforeNode;
		}
		if (!(l.html.lastRenderedChild === ptrType.nil)) {
			parent.lastRenderedChild = l.html.lastRenderedChild;
		}
		pendingMounts = pendingMounts;
		$s = -1; return pendingMounts;
		/* */ } return; } var $f = {$blk: KeyedList.ptr.prototype.reconcile, $c: true, $r, _r, _r$1, _r$2, _r$3, _r$4, _r$5, _ref, _tuple, _v, keyer, l, ok, parent, pendingMounts, prev, prevChild, v, v$1, v$2, $s};return $f;
	};
	KeyedList.prototype.reconcile = function(parent, prevChild) { return this.$val.reconcile(parent, prevChild); };
	KeyedList.ptr.prototype.remove = function(parent) {
		var {l, parent, $s, $r, $c} = $restore(this, {parent});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		l = this;
		l.html.node = parent.node;
		l.html.insertBeforeNode = parent.insertBeforeNode;
		$r = l.html.removeChildren(l.html.children); /* */ $s = 1; case 1: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		if (!($interfaceIsEqual(parent.insertBeforeNode, $ifaceNil))) {
			parent.insertBeforeNode = l.html.insertBeforeNode;
		}
		$s = -1; return;
		/* */ } return; } var $f = {$blk: KeyedList.ptr.prototype.remove, $c: true, $r, l, parent, $s};return $f;
	};
	KeyedList.prototype.remove = function(parent) { return this.$val.remove(parent); };
	Tag = function(tag, m) {
		var {_i, _ref, h, m, m$1, tag, $s, $r, $c} = $restore(this, {tag, m});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		h = new HTML.ptr($ifaceNil, "", tag, "", "", false, false, false, false, false, sliceType$5.nil, sliceType$6.nil, $ifaceNil, false, $ifaceNil, ptrType.nil);
		_ref = m;
		_i = 0;
		/* while (true) { */ case 1:
			/* if (!(_i < _ref.$length)) { break; } */ if(!(_i < _ref.$length)) { $s = 2; continue; }
			m$1 = ((_i < 0 || _i >= _ref.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref.$array[_ref.$offset + _i]);
			$r = apply(m$1, h); /* */ $s = 3; case 3: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
			_i++;
		$s = 1; continue;
		case 2:
		$s = -1; return h;
		/* */ } return; } var $f = {$blk: Tag, $c: true, $r, _i, _ref, h, m, m$1, tag, $s};return $f;
	};
	$pkg.Tag = Tag;
	batchRenderer.ptr.prototype.render = function(startTime) {
		var {_i, _i$1, _key, _r, _r$1, _r$2, _r$3, _r$4, _r$5, _r$6, _r$7, _ref, _ref$1, _tuple, avgRenderTime, b, budgetRemaining, c, c$1, elapsed, i, i$1, nextHTML, pending, pendingMounts, prevHTML, skip, startTime, $s, $r, $c} = $restore(this, {startTime});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		b = this;
		if (b.batch.$length === 0) {
			b.scheduled = false;
			$s = -1; return;
		}
		pending = b.batch;
		b.batch = sliceType.nil;
		b.idx = new $global.Map();
		_ref = pending;
		_i = 0;
		/* while (true) { */ case 1:
			/* if (!(_i < _ref.$length)) { break; } */ if(!(_i < _ref.$length)) { $s = 2; continue; }
			i = _i;
			c = ((_i < 0 || _i >= _ref.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref.$array[_ref.$offset + _i]);
			_r = c.Context(); /* */ $s = 5; case 5: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
			/* */ if (_r.unmounted) { $s = 3; continue; }
			/* */ $s = 4; continue;
			/* if (_r.unmounted) { */ case 3:
				_i++;
				/* continue; */ $s = 1; continue;
			/* } */ case 4:
			/* */ if (i > 0) { $s = 6; continue; }
			/* */ $s = 7; continue;
			/* if (i > 0) { */ case 6:
				_r$1 = global().Get("performance"); /* */ $s = 8; case 8: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
				_r$2 = _r$1.Call("now", sliceType$2.nil); /* */ $s = 9; case 9: if($c) { $c = false; _r$2 = _r$2.$blk(); } if (_r$2 && _r$2.$blk !== undefined) { break s; }
				_r$3 = _r$2.Float(); /* */ $s = 10; case 10: if($c) { $c = false; _r$3 = _r$3.$blk(); } if (_r$3 && _r$3.$blk !== undefined) { break s; }
				elapsed = _r$3 - startTime;
				budgetRemaining = 16 - elapsed;
				avgRenderTime = elapsed / (i);
				if (budgetRemaining < avgRenderTime * 2) {
					b.batch = $subslice(pending, i);
					_ref$1 = b.batch;
					_i$1 = 0;
					while (true) {
						if (!(_i$1 < _ref$1.$length)) { break; }
						i$1 = _i$1;
						c$1 = ((_i$1 < 0 || _i$1 >= _ref$1.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref$1.$array[_ref$1.$offset + _i$1]);
						_key = c$1; (b.idx || $throwRuntimeError("assignment to entry in nil map")).set(Component.keyFor(_key), { k: _key, v: i$1 });
						_i$1++;
					}
					/* break; */ $s = 2; continue;
				}
			/* } */ case 7:
			_r$4 = c.Context(); /* */ $s = 11; case 11: if($c) { $c = false; _r$4 = _r$4.$blk(); } if (_r$4 && _r$4.$blk !== undefined) { break s; }
			_r$5 = extractHTML(_r$4.prevRender); /* */ $s = 12; case 12: if($c) { $c = false; _r$5 = _r$5.$blk(); } if (_r$5 && _r$5.$blk !== undefined) { break s; }
			prevHTML = _r$5;
			_r$6 = renderComponent(c, c); /* */ $s = 13; case 13: if($c) { $c = false; _r$6 = _r$6.$blk(); } if (_r$6 && _r$6.$blk !== undefined) { break s; }
			_tuple = _r$6;
			nextHTML = _tuple[0];
			skip = _tuple[1];
			pendingMounts = _tuple[2];
			if (skip) {
				_i++;
				/* continue; */ $s = 1; continue;
			}
			$r = replaceNode(nextHTML.node, prevHTML.node); /* */ $s = 14; case 14: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
			$r = mount(pendingMounts); /* */ $s = 15; case 15: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
			_i++;
		$s = 1; continue;
		case 2:
		_r$7 = requestAnimationFrame($methodVal(b, "render")); /* */ $s = 16; case 16: if($c) { $c = false; _r$7 = _r$7.$blk(); } if (_r$7 && _r$7.$blk !== undefined) { break s; }
		_r$7;
		$s = -1; return;
		/* */ } return; } var $f = {$blk: batchRenderer.ptr.prototype.render, $c: true, $r, _i, _i$1, _key, _r, _r$1, _r$2, _r$3, _r$4, _r$5, _r$6, _r$7, _ref, _ref$1, _tuple, avgRenderTime, b, budgetRemaining, c, c$1, elapsed, i, i$1, nextHTML, pending, pendingMounts, prevHTML, skip, startTime, $s};return $f;
	};
	batchRenderer.prototype.render = function(startTime) { return this.$val.render(startTime); };
	extractHTML = function(e) {
		var {$24r, _r, _r$1, _r$2, _ref, e, v, v$1, v$2, v$3, $s, $r, $c} = $restore(this, {e});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		_ref = e;
		/* */ if (_ref === $ifaceNil) { $s = 1; continue; }
		/* */ if ($assertType(_ref, ptrType, true)[1]) { $s = 2; continue; }
		/* */ if ($assertType(_ref, Component, true)[1]) { $s = 3; continue; }
		/* */ $s = 4; continue;
		/* if (_ref === $ifaceNil) { */ case 1:
			v = _ref;
			$s = -1; return ptrType.nil;
		/* } else if ($assertType(_ref, ptrType, true)[1]) { */ case 2:
			v$1 = _ref.$val;
			$s = -1; return v$1;
		/* } else if ($assertType(_ref, Component, true)[1]) { */ case 3:
			v$2 = _ref;
			_r = v$2.Context(); /* */ $s = 6; case 6: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
			_r$1 = extractHTML(_r.prevRender); /* */ $s = 7; case 7: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
			$24r = _r$1;
			$s = 8; case 8: return $24r;
		/* } else { */ case 4:
			v$3 = _ref;
			_r$2 = reflect.TypeOf(e).String(); /* */ $s = 9; case 9: if($c) { $c = false; _r$2 = _r$2.$blk(); } if (_r$2 && _r$2.$blk !== undefined) { break s; }
			$panic(new $String("vecty: internal error (unexpected ComponentOrHTML type " + _r$2 + ")"));
		/* } */ case 5:
		$s = -1; return ptrType.nil;
		/* */ } return; } var $f = {$blk: extractHTML, $c: true, $r, $24r, _r, _r$1, _r$2, _ref, e, v, v$1, v$2, v$3, $s};return $f;
	};
	sameType = function(first, second) {
		var first, second;
		return $interfaceIsEqual(reflect.TypeOf(first), reflect.TypeOf(second));
	};
	copyComponent = function(c) {
		var {$24r, _r, _r$1, _r$10, _r$2, _r$3, _r$4, _r$5, _r$6, _r$7, _r$8, _r$9, _tuple, _v, c, copier, cpy, cpy$1, ok, v, $s, $r, $c} = $restore(this, {c});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		if ($interfaceIsEqual(c, $ifaceNil)) {
			$panic(new $String("vecty: internal error (cannot copy nil Component)"));
		}
		_tuple = $assertType(c, Copier, true);
		copier = _tuple[0];
		ok = _tuple[1];
		/* */ if (ok) { $s = 1; continue; }
		/* */ $s = 2; continue;
		/* if (ok) { */ case 1:
			_r = copier.Copy(); /* */ $s = 3; case 3: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
			cpy = _r;
			if ($interfaceIsEqual(cpy, c)) {
				$panic(new $String("vecty: Component.Copy illegally returned an identical *MyComponent pointer"));
			}
			$s = -1; return cpy;
		/* } */ case 2:
		tinyGoAssertCopier(c);
		_r$1 = reflect.ValueOf(c); /* */ $s = 4; case 4: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
		v = _r$1;
		if (!(($clone(v, reflect.Value).Kind() === 22))) { _v = true; $s = 7; continue s; }
		_r$2 = $clone(v, reflect.Value).Elem(); /* */ $s = 8; case 8: if($c) { $c = false; _r$2 = _r$2.$blk(); } if (_r$2 && _r$2.$blk !== undefined) { break s; }
		_r$3 = $clone(_r$2, reflect.Value).Kind(); /* */ $s = 9; case 9: if($c) { $c = false; _r$3 = _r$3.$blk(); } if (_r$3 && _r$3.$blk !== undefined) { break s; }
		_v = !((_r$3 === 25)); case 7:
		/* */ if (_v) { $s = 5; continue; }
		/* */ $s = 6; continue;
		/* if (_v) { */ case 5:
			_r$4 = reflect.TypeOf(c).String(); /* */ $s = 10; case 10: if($c) { $c = false; _r$4 = _r$4.$blk(); } if (_r$4 && _r$4.$blk !== undefined) { break s; }
			$panic(new $String("vecty: Component must be pointer to struct, found " + _r$4));
		/* } */ case 6:
		_r$5 = $clone(v, reflect.Value).Elem(); /* */ $s = 11; case 11: if($c) { $c = false; _r$5 = _r$5.$blk(); } if (_r$5 && _r$5.$blk !== undefined) { break s; }
		_r$6 = $clone(_r$5, reflect.Value).Type(); /* */ $s = 12; case 12: if($c) { $c = false; _r$6 = _r$6.$blk(); } if (_r$6 && _r$6.$blk !== undefined) { break s; }
		_r$7 = reflect.New(_r$6); /* */ $s = 13; case 13: if($c) { $c = false; _r$7 = _r$7.$blk(); } if (_r$7 && _r$7.$blk !== undefined) { break s; }
		cpy$1 = _r$7;
		_r$8 = $clone(cpy$1, reflect.Value).Elem(); /* */ $s = 14; case 14: if($c) { $c = false; _r$8 = _r$8.$blk(); } if (_r$8 && _r$8.$blk !== undefined) { break s; }
		_r$9 = $clone(v, reflect.Value).Elem(); /* */ $s = 15; case 15: if($c) { $c = false; _r$9 = _r$9.$blk(); } if (_r$9 && _r$9.$blk !== undefined) { break s; }
		$r = $clone(_r$8, reflect.Value).Set($clone(_r$9, reflect.Value)); /* */ $s = 16; case 16: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		_r$10 = $clone(cpy$1, reflect.Value).Interface(); /* */ $s = 17; case 17: if($c) { $c = false; _r$10 = _r$10.$blk(); } if (_r$10 && _r$10.$blk !== undefined) { break s; }
		$24r = $assertType(_r$10, Component);
		$s = 18; case 18: return $24r;
		/* */ } return; } var $f = {$blk: copyComponent, $c: true, $r, $24r, _r, _r$1, _r$10, _r$2, _r$3, _r$4, _r$5, _r$6, _r$7, _r$8, _r$9, _tuple, _v, c, copier, cpy, cpy$1, ok, v, $s};return $f;
	};
	copyProps = function(src, dst) {
		var {_r, _r$1, _r$10, _r$11, _r$2, _r$3, _r$4, _r$5, _r$6, _r$7, _r$8, _r$9, d, df, dst, i, s, sf, src, $s, $r, $c} = $restore(this, {src, dst});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		if ($interfaceIsEqual(src, dst)) {
			$s = -1; return;
		}
		_r = reflect.ValueOf(src); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		s = _r;
		_r$1 = reflect.ValueOf(dst); /* */ $s = 2; case 2: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
		d = _r$1;
		if (!($interfaceIsEqual($clone(s, reflect.Value).Type(), $clone(d, reflect.Value).Type()))) {
			$panic(new $String("vecty: internal error (attempted to copy properties of incompatible structs)"));
		}
		if (!(($clone(s, reflect.Value).Kind() === 22)) || !(($clone(d, reflect.Value).Kind() === 22))) {
			$panic(new $String("vecty: internal error (attempted to copy properties of non-pointer)"));
		}
		i = 0;
		/* while (true) { */ case 3:
			_r$2 = $clone(s, reflect.Value).Elem(); /* */ $s = 5; case 5: if($c) { $c = false; _r$2 = _r$2.$blk(); } if (_r$2 && _r$2.$blk !== undefined) { break s; }
			_r$3 = $clone(_r$2, reflect.Value).NumField(); /* */ $s = 6; case 6: if($c) { $c = false; _r$3 = _r$3.$blk(); } if (_r$3 && _r$3.$blk !== undefined) { break s; }
			/* if (!(i < _r$3)) { break; } */ if(!(i < _r$3)) { $s = 4; continue; }
			_r$4 = $clone(s, reflect.Value).Elem(); /* */ $s = 7; case 7: if($c) { $c = false; _r$4 = _r$4.$blk(); } if (_r$4 && _r$4.$blk !== undefined) { break s; }
			_r$5 = $clone(_r$4, reflect.Value).Field(i); /* */ $s = 8; case 8: if($c) { $c = false; _r$5 = _r$5.$blk(); } if (_r$5 && _r$5.$blk !== undefined) { break s; }
			sf = _r$5;
			_r$6 = $clone(s, reflect.Value).Elem(); /* */ $s = 11; case 11: if($c) { $c = false; _r$6 = _r$6.$blk(); } if (_r$6 && _r$6.$blk !== undefined) { break s; }
			_r$7 = $clone(_r$6, reflect.Value).Type(); /* */ $s = 12; case 12: if($c) { $c = false; _r$7 = _r$7.$blk(); } if (_r$7 && _r$7.$blk !== undefined) { break s; }
			_r$8 = _r$7.Field(i); /* */ $s = 13; case 13: if($c) { $c = false; _r$8 = _r$8.$blk(); } if (_r$8 && _r$8.$blk !== undefined) { break s; }
			_r$9 = new reflect.StructTag(_r$8.Tag).Get("vecty"); /* */ $s = 14; case 14: if($c) { $c = false; _r$9 = _r$9.$blk(); } if (_r$9 && _r$9.$blk !== undefined) { break s; }
			/* */ if (_r$9 === "prop") { $s = 9; continue; }
			/* */ $s = 10; continue;
			/* if (_r$9 === "prop") { */ case 9:
				_r$10 = $clone(d, reflect.Value).Elem(); /* */ $s = 15; case 15: if($c) { $c = false; _r$10 = _r$10.$blk(); } if (_r$10 && _r$10.$blk !== undefined) { break s; }
				_r$11 = $clone(_r$10, reflect.Value).Field(i); /* */ $s = 16; case 16: if($c) { $c = false; _r$11 = _r$11.$blk(); } if (_r$11 && _r$11.$blk !== undefined) { break s; }
				df = _r$11;
				if (!($interfaceIsEqual($clone(sf, reflect.Value).Type(), $clone(df, reflect.Value).Type()))) {
					$panic(new $String("vecty: internal error (should never be possible, struct types are identical)"));
				}
				$r = $clone(df, reflect.Value).Set($clone(sf, reflect.Value)); /* */ $s = 17; case 17: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
			/* } */ case 10:
			i = i + (1) >> 0;
		$s = 3; continue;
		case 4:
		$s = -1; return;
		/* */ } return; } var $f = {$blk: copyProps, $c: true, $r, _r, _r$1, _r$10, _r$11, _r$2, _r$3, _r$4, _r$5, _r$6, _r$7, _r$8, _r$9, d, df, dst, i, s, sf, src, $s};return $f;
	};
	render = function(next, prev) {
		var {$24r, _r, _r$1, _r$2, _r$3, _ref, _tmp, _tmp$1, _tmp$2, _tmp$3, _tmp$4, _tmp$5, _tuple, next, nextHTML, pendingMounts, prev, skip, v, v$1, v$2, v$3, $s, $r, $c} = $restore(this, {next, prev});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		nextHTML = ptrType.nil;
		skip = false;
		pendingMounts = sliceType$4.nil;
		_ref = next;
		/* */ if ($assertType(_ref, ptrType, true)[1]) { $s = 1; continue; }
		/* */ if ($assertType(_ref, Component, true)[1]) { $s = 2; continue; }
		/* */ if (_ref === $ifaceNil) { $s = 3; continue; }
		/* */ $s = 4; continue;
		/* if ($assertType(_ref, ptrType, true)[1]) { */ case 1:
			v = _ref.$val;
			_r = extractHTML(prev); /* */ $s = 6; case 6: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
			_r$1 = v.reconcile(_r); /* */ $s = 7; case 7: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
			pendingMounts = _r$1;
			_tmp = v;
			_tmp$1 = false;
			_tmp$2 = pendingMounts;
			nextHTML = _tmp;
			skip = _tmp$1;
			pendingMounts = _tmp$2;
			$s = -1; return [nextHTML, skip, pendingMounts];
		/* } else if ($assertType(_ref, Component, true)[1]) { */ case 2:
			v$1 = _ref;
			_r$2 = renderComponent(v$1, prev); /* */ $s = 8; case 8: if($c) { $c = false; _r$2 = _r$2.$blk(); } if (_r$2 && _r$2.$blk !== undefined) { break s; }
			_tuple = _r$2;
			nextHTML = _tuple[0];
			skip = _tuple[1];
			pendingMounts = _tuple[2];
			$24r = [nextHTML, skip, pendingMounts];
			$s = 9; case 9: return $24r;
		/* } else if (_ref === $ifaceNil) { */ case 3:
			v$2 = _ref;
			_tmp$3 = ptrType.nil;
			_tmp$4 = false;
			_tmp$5 = sliceType$4.nil;
			nextHTML = _tmp$3;
			skip = _tmp$4;
			pendingMounts = _tmp$5;
			$s = -1; return [nextHTML, skip, pendingMounts];
		/* } else { */ case 4:
			v$3 = _ref;
			_r$3 = reflect.TypeOf(next).String(); /* */ $s = 10; case 10: if($c) { $c = false; _r$3 = _r$3.$blk(); } if (_r$3 && _r$3.$blk !== undefined) { break s; }
			$panic(new $String("vecty: internal error (unexpected ComponentOrHTML type " + _r$3 + ")"));
		/* } */ case 5:
		$s = -1; return [nextHTML, skip, pendingMounts];
		/* */ } return; } var $f = {$blk: render, $c: true, $r, $24r, _r, _r$1, _r$2, _r$3, _ref, _tmp, _tmp$1, _tmp$2, _tmp$3, _tmp$4, _tmp$5, _tuple, next, nextHTML, pendingMounts, prev, skip, v, v$1, v$2, v$3, $s};return $f;
	};
	renderComponent = function(next, prev) {
		var {_r, _r$1, _r$10, _r$11, _r$12, _r$13, _r$14, _r$2, _r$3, _r$4, _r$5, _r$6, _r$7, _r$8, _r$9, _ref, _tmp, _tmp$1, _tmp$2, _tmp$3, _tmp$4, _tmp$5, _tmp$6, _tmp$7, _tmp$8, _tuple, _tuple$1, _tuple$2, _tuple$3, m, next, nextHTML, nextRender, ok, ok$1, ok$2, pendingMounts, prev, prevComponent, prevComponent$1, prevRender, prevRenderComponent, rs, skip, v, v$1, v$2, $s, $r, $c} = $restore(this, {next, prev});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		nextHTML = ptrType.nil;
		skip = false;
		pendingMounts = sliceType$4.nil;
		_tuple = $assertType(prev, Component, true);
		prevComponent = _tuple[0];
		ok = _tuple[1];
		/* */ if (ok && sameType(next, prevComponent)) { $s = 1; continue; }
		/* */ $s = 2; continue;
		/* if (ok && sameType(next, prevComponent)) { */ case 1:
			$r = copyProps(next, prevComponent); /* */ $s = 3; case 3: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
			next = prevComponent;
		/* } */ case 2:
		_tuple$1 = $assertType(next, RenderSkipper, true);
		rs = _tuple$1[0];
		ok$1 = _tuple$1[1];
		/* */ if (ok$1) { $s = 4; continue; }
		/* */ $s = 5; continue;
		/* if (ok$1) { */ case 4:
			_r = next.Context(); /* */ $s = 6; case 6: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
			prevRenderComponent = _r.prevRenderComponent;
			/* */ if (!($interfaceIsEqual(prevRenderComponent, $ifaceNil))) { $s = 7; continue; }
			/* */ $s = 8; continue;
			/* if (!($interfaceIsEqual(prevRenderComponent, $ifaceNil))) { */ case 7:
				if ($interfaceIsEqual(next, prevRenderComponent)) {
					$panic(new $String("vecty: internal error (SkipRender called with identical prev component)"));
				}
				_r$1 = rs.SkipRender(prevRenderComponent); /* */ $s = 11; case 11: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
				/* */ if (_r$1) { $s = 9; continue; }
				/* */ $s = 10; continue;
				/* if (_r$1) { */ case 9:
					_tmp = ptrType.nil;
					_tmp$1 = true;
					_tmp$2 = sliceType$4.nil;
					nextHTML = _tmp;
					skip = _tmp$1;
					pendingMounts = _tmp$2;
					$s = -1; return [nextHTML, skip, pendingMounts];
				/* } */ case 10:
			/* } */ case 8:
		/* } */ case 5:
		_r$2 = next.Render(); /* */ $s = 12; case 12: if($c) { $c = false; _r$2 = _r$2.$blk(); } if (_r$2 && _r$2.$blk !== undefined) { break s; }
		nextRender = _r$2;
		_r$3 = next.Context(); /* */ $s = 13; case 13: if($c) { $c = false; _r$3 = _r$3.$blk(); } if (_r$3 && _r$3.$blk !== undefined) { break s; }
		prevRender = _r$3.prevRender;
		/* */ if ($interfaceIsEqual(nextRender, $ifaceNil)) { $s = 14; continue; }
		/* */ $s = 15; continue;
		/* if ($interfaceIsEqual(nextRender, $ifaceNil)) { */ case 14:
			_r$4 = Tag("noscript", sliceType$7.nil); /* */ $s = 16; case 16: if($c) { $c = false; _r$4 = _r$4.$blk(); } if (_r$4 && _r$4.$blk !== undefined) { break s; }
			nextRender = _r$4;
		/* } */ case 15:
		_ref = nextRender;
		/* */ if ($assertType(_ref, Component, true)[1]) { $s = 17; continue; }
		/* */ if ($assertType(_ref, ptrType, true)[1]) { $s = 18; continue; }
		/* */ $s = 19; continue;
		/* if ($assertType(_ref, Component, true)[1]) { */ case 17:
			v = _ref;
			_r$5 = renderComponent(v, prevRender); /* */ $s = 21; case 21: if($c) { $c = false; _r$5 = _r$5.$blk(); } if (_r$5 && _r$5.$blk !== undefined) { break s; }
			_tuple$2 = _r$5;
			nextHTML = _tuple$2[0];
			skip = _tuple$2[1];
			pendingMounts = _tuple$2[2];
			if (skip) {
				_tmp$3 = nextHTML;
				_tmp$4 = skip;
				_tmp$5 = pendingMounts;
				nextHTML = _tmp$3;
				skip = _tmp$4;
				pendingMounts = _tmp$5;
				$s = -1; return [nextHTML, skip, pendingMounts];
			}
			_tuple$3 = $assertType(prevRender, Component, true);
			prevComponent$1 = _tuple$3[0];
			ok$2 = _tuple$3[1];
			if (ok$2 && sameType(v, prevComponent$1)) {
				nextRender = prevRender;
			}
			$s = 20; continue;
		/* } else if ($assertType(_ref, ptrType, true)[1]) { */ case 18:
			v$1 = _ref.$val;
			/* */ if (v$1 === ptrType.nil) { $s = 22; continue; }
			/* */ $s = 23; continue;
			/* if (v$1 === ptrType.nil) { */ case 22:
				_r$6 = Tag("noscript", sliceType$7.nil); /* */ $s = 24; case 24: if($c) { $c = false; _r$6 = _r$6.$blk(); } if (_r$6 && _r$6.$blk !== undefined) { break s; }
				v$1 = _r$6;
			/* } */ case 23:
			nextHTML = v$1;
			_r$7 = extractHTML(prev); /* */ $s = 25; case 25: if($c) { $c = false; _r$7 = _r$7.$blk(); } if (_r$7 && _r$7.$blk !== undefined) { break s; }
			_r$8 = nextHTML.reconcile(_r$7); /* */ $s = 26; case 26: if($c) { $c = false; _r$8 = _r$8.$blk(); } if (_r$8 && _r$8.$blk !== undefined) { break s; }
			pendingMounts = _r$8;
			$s = 20; continue;
		/* } else { */ case 19:
			v$2 = _ref;
			_r$9 = reflect.TypeOf(v$2).String(); /* */ $s = 27; case 27: if($c) { $c = false; _r$9 = _r$9.$blk(); } if (_r$9 && _r$9.$blk !== undefined) { break s; }
			$panic(new $String("vecty: internal error (unexpected ComponentOrHTML type " + _r$9 + ")"));
		/* } */ case 20:
		_r$10 = mountUnmount(nextRender, prevRender); /* */ $s = 28; case 28: if($c) { $c = false; _r$10 = _r$10.$blk(); } if (_r$10 && _r$10.$blk !== undefined) { break s; }
		m = _r$10;
		if (!($interfaceIsEqual(m, $ifaceNil))) {
			pendingMounts = $append(pendingMounts, m);
		}
		_r$11 = next.Context(); /* */ $s = 29; case 29: if($c) { $c = false; _r$11 = _r$11.$blk(); } if (_r$11 && _r$11.$blk !== undefined) { break s; }
		_r$11.prevRender = nextRender;
		_r$12 = copyComponent(next); /* */ $s = 30; case 30: if($c) { $c = false; _r$12 = _r$12.$blk(); } if (_r$12 && _r$12.$blk !== undefined) { break s; }
		_r$13 = next.Context(); /* */ $s = 31; case 31: if($c) { $c = false; _r$13 = _r$13.$blk(); } if (_r$13 && _r$13.$blk !== undefined) { break s; }
		_r$13.prevRenderComponent = _r$12;
		_r$14 = next.Context(); /* */ $s = 32; case 32: if($c) { $c = false; _r$14 = _r$14.$blk(); } if (_r$14 && _r$14.$blk !== undefined) { break s; }
		_r$14.unmounted = false;
		_tmp$6 = nextHTML;
		_tmp$7 = false;
		_tmp$8 = pendingMounts;
		nextHTML = _tmp$6;
		skip = _tmp$7;
		pendingMounts = _tmp$8;
		$s = -1; return [nextHTML, skip, pendingMounts];
		/* */ } return; } var $f = {$blk: renderComponent, $c: true, $r, _r, _r$1, _r$10, _r$11, _r$12, _r$13, _r$14, _r$2, _r$3, _r$4, _r$5, _r$6, _r$7, _r$8, _r$9, _ref, _tmp, _tmp$1, _tmp$2, _tmp$3, _tmp$4, _tmp$5, _tmp$6, _tmp$7, _tmp$8, _tuple, _tuple$1, _tuple$2, _tuple$3, m, next, nextHTML, nextRender, ok, ok$1, ok$2, pendingMounts, prev, prevComponent, prevComponent$1, prevRender, prevRenderComponent, rs, skip, v, v$1, v$2, $s};return $f;
	};
	mountUnmount = function(next, prev) {
		var {_i, _r, _r$1, _r$2, _ref, _tuple, _tuple$1, _tuple$2, _v, child, m, m$1, next, nextHTML, ok, ok$1, ok$2, prev, prevHTML, u, $s, $r, $c} = $restore(this, {next, prev});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		if ($interfaceIsEqual(next, prev)) {
			$s = -1; return $ifaceNil;
		}
		/* */ if (!sameType(next, prev)) { $s = 1; continue; }
		/* */ $s = 2; continue;
		/* if (!sameType(next, prev)) { */ case 1:
			/* */ if (!($interfaceIsEqual(prev, $ifaceNil))) { $s = 3; continue; }
			/* */ $s = 4; continue;
			/* if (!($interfaceIsEqual(prev, $ifaceNil))) { */ case 3:
				$r = unmount(prev); /* */ $s = 5; case 5: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
			/* } */ case 4:
			_tuple = $assertType(next, Mounter, true);
			m = _tuple[0];
			ok = _tuple[1];
			if (ok) {
				$s = -1; return m;
			}
			$s = -1; return $ifaceNil;
		/* } */ case 2:
		_r = extractHTML(prev); /* */ $s = 6; case 6: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		prevHTML = _r;
		/* */ if (!(prevHTML === ptrType.nil)) { $s = 7; continue; }
		/* */ $s = 8; continue;
		/* if (!(prevHTML === ptrType.nil)) { */ case 7:
			_r$1 = extractHTML(next); /* */ $s = 9; case 9: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
			nextHTML = _r$1;
			if (nextHTML === ptrType.nil) { _v = true; $s = 12; continue s; }
			_r$2 = prevHTML.node.Equal(nextHTML.node); /* */ $s = 13; case 13: if($c) { $c = false; _r$2 = _r$2.$blk(); } if (_r$2 && _r$2.$blk !== undefined) { break s; }
			_v = !_r$2; case 12:
			/* */ if (_v) { $s = 10; continue; }
			/* */ $s = 11; continue;
			/* if (_v) { */ case 10:
				_ref = prevHTML.children;
				_i = 0;
				/* while (true) { */ case 14:
					/* if (!(_i < _ref.$length)) { break; } */ if(!(_i < _ref.$length)) { $s = 15; continue; }
					child = ((_i < 0 || _i >= _ref.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref.$array[_ref.$offset + _i]);
					$r = unmount(child); /* */ $s = 16; case 16: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
					_i++;
				$s = 14; continue;
				case 15:
			/* } */ case 11:
		/* } */ case 8:
		_tuple$1 = $assertType(prev, Unmounter, true);
		u = _tuple$1[0];
		ok$1 = _tuple$1[1];
		/* */ if (ok$1) { $s = 17; continue; }
		/* */ $s = 18; continue;
		/* if (ok$1) { */ case 17:
			$r = u.Unmount(); /* */ $s = 19; case 19: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		/* } */ case 18:
		_tuple$2 = $assertType(next, Mounter, true);
		m$1 = _tuple$2[0];
		ok$2 = _tuple$2[1];
		if (ok$2) {
			$s = -1; return m$1;
		}
		$s = -1; return $ifaceNil;
		/* */ } return; } var $f = {$blk: mountUnmount, $c: true, $r, _i, _r, _r$1, _r$2, _ref, _tuple, _tuple$1, _tuple$2, _v, child, m, m$1, next, nextHTML, ok, ok$1, ok$2, prev, prevHTML, u, $s};return $f;
	};
	mount = function(pendingMounts) {
		var {_i, _r, _r$1, _r$2, _ref, _tuple, c, mounter, ok, pendingMounts, $s, $r, $c} = $restore(this, {pendingMounts});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		_ref = pendingMounts;
		_i = 0;
		/* while (true) { */ case 1:
			/* if (!(_i < _ref.$length)) { break; } */ if(!(_i < _ref.$length)) { $s = 2; continue; }
			mounter = ((_i < 0 || _i >= _ref.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref.$array[_ref.$offset + _i]);
			if ($interfaceIsEqual(mounter, $ifaceNil)) {
				_i++;
				/* continue; */ $s = 1; continue;
			}
			_tuple = $assertType(mounter, Component, true);
			c = _tuple[0];
			ok = _tuple[1];
			/* */ if (ok) { $s = 3; continue; }
			/* */ $s = 4; continue;
			/* if (ok) { */ case 3:
				_r = c.Context(); /* */ $s = 7; case 7: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
				/* */ if (_r.mounted) { $s = 5; continue; }
				/* */ $s = 6; continue;
				/* if (_r.mounted) { */ case 5:
					_i++;
					/* continue; */ $s = 1; continue;
				/* } */ case 6:
				_r$1 = c.Context(); /* */ $s = 8; case 8: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
				_r$1.mounted = true;
				_r$2 = c.Context(); /* */ $s = 9; case 9: if($c) { $c = false; _r$2 = _r$2.$blk(); } if (_r$2 && _r$2.$blk !== undefined) { break s; }
				_r$2.unmounted = false;
			/* } */ case 4:
			$r = mounter.Mount(); /* */ $s = 10; case 10: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
			_i++;
		$s = 1; continue;
		case 2:
		$s = -1; return;
		/* */ } return; } var $f = {$blk: mount, $c: true, $r, _i, _r, _r$1, _r$2, _ref, _tuple, c, mounter, ok, pendingMounts, $s};return $f;
	};
	unmount = function(e) {
		var {_i, _i$1, _r, _r$1, _r$2, _r$3, _r$4, _ref, _ref$1, _tuple, _tuple$1, _tuple$2, _tuple$3, c, child, child$1, e, h, l, ok, ok$1, ok$2, ok$3, prevRenderComponent, u, $s, $r, $c} = $restore(this, {e});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		_tuple = $assertType(e, Component, true);
		c = _tuple[0];
		ok = _tuple[1];
		/* */ if (ok) { $s = 1; continue; }
		/* */ $s = 2; continue;
		/* if (ok) { */ case 1:
			_r = c.Context(); /* */ $s = 5; case 5: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
			/* */ if (_r.unmounted) { $s = 3; continue; }
			/* */ $s = 4; continue;
			/* if (_r.unmounted) { */ case 3:
				$s = -1; return;
			/* } */ case 4:
			_r$1 = c.Context(); /* */ $s = 6; case 6: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
			_r$1.unmounted = true;
			_r$2 = c.Context(); /* */ $s = 7; case 7: if($c) { $c = false; _r$2 = _r$2.$blk(); } if (_r$2 && _r$2.$blk !== undefined) { break s; }
			_r$2.mounted = false;
			_r$3 = c.Context(); /* */ $s = 8; case 8: if($c) { $c = false; _r$3 = _r$3.$blk(); } if (_r$3 && _r$3.$blk !== undefined) { break s; }
			_tuple$1 = $assertType(_r$3.prevRender, Component, true);
			prevRenderComponent = _tuple$1[0];
			ok$1 = _tuple$1[1];
			/* */ if (ok$1) { $s = 9; continue; }
			/* */ $s = 10; continue;
			/* if (ok$1) { */ case 9:
				$r = unmount(prevRenderComponent); /* */ $s = 11; case 11: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
			/* } */ case 10:
		/* } */ case 2:
		_tuple$2 = $assertType(e, KeyedList, true);
		l = $clone(_tuple$2[0], KeyedList);
		ok$2 = _tuple$2[1];
		/* */ if (ok$2) { $s = 12; continue; }
		/* */ $s = 13; continue;
		/* if (ok$2) { */ case 12:
			_ref = l.html.children;
			_i = 0;
			/* while (true) { */ case 14:
				/* if (!(_i < _ref.$length)) { break; } */ if(!(_i < _ref.$length)) { $s = 15; continue; }
				child = ((_i < 0 || _i >= _ref.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref.$array[_ref.$offset + _i]);
				$r = unmount(child); /* */ $s = 16; case 16: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
				_i++;
			$s = 14; continue;
			case 15:
			$s = -1; return;
		/* } */ case 13:
		_r$4 = extractHTML(e); /* */ $s = 17; case 17: if($c) { $c = false; _r$4 = _r$4.$blk(); } if (_r$4 && _r$4.$blk !== undefined) { break s; }
		h = _r$4;
		/* */ if (!(h === ptrType.nil)) { $s = 18; continue; }
		/* */ $s = 19; continue;
		/* if (!(h === ptrType.nil)) { */ case 18:
			_ref$1 = h.children;
			_i$1 = 0;
			/* while (true) { */ case 20:
				/* if (!(_i$1 < _ref$1.$length)) { break; } */ if(!(_i$1 < _ref$1.$length)) { $s = 21; continue; }
				child$1 = ((_i$1 < 0 || _i$1 >= _ref$1.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref$1.$array[_ref$1.$offset + _i$1]);
				$r = unmount(child$1); /* */ $s = 22; case 22: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
				_i$1++;
			$s = 20; continue;
			case 21:
		/* } */ case 19:
		_tuple$3 = $assertType(e, Unmounter, true);
		u = _tuple$3[0];
		ok$3 = _tuple$3[1];
		/* */ if (ok$3) { $s = 23; continue; }
		/* */ $s = 24; continue;
		/* if (ok$3) { */ case 23:
			$r = u.Unmount(); /* */ $s = 25; case 25: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		/* } */ case 24:
		$s = -1; return;
		/* */ } return; } var $f = {$blk: unmount, $c: true, $r, _i, _i$1, _r, _r$1, _r$2, _r$3, _r$4, _ref, _ref$1, _tuple, _tuple$1, _tuple$2, _tuple$3, c, child, child$1, e, h, l, ok, ok$1, ok$2, ok$3, prevRenderComponent, u, $s};return $f;
	};
	requestAnimationFrame = function(callback) {
		var {$24r, _r, _r$1, callback, cb, $s, $r, $c} = $restore(this, {callback});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		callback = [callback];
		cb = [cb];
		cb[0] = $ifaceNil;
		cb[0] = funcOf((function(callback, cb) { return function $b(this$1, args) {
			var {_r, args, this$1, x, $s, $r, $c} = $restore(this, {this$1, args});
			/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
			$r = cb[0].Release(); /* */ $s = 1; case 1: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
			_r = (0 >= args.$length ? ($throwRuntimeError("index out of range"), undefined) : args.$array[args.$offset + 0]).Float(); /* */ $s = 2; case 2: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
			$r = callback[0](_r); /* */ $s = 3; case 3: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
			$s = -1; return (x = undefined$1(), new x.constructor.elem(x));
			/* */ } return; } var $f = {$blk: $b, $c: true, $r, _r, args, this$1, x, $s};return $f;
		}; })(callback, cb));
		_r = global().Call("requestAnimationFrame", new sliceType$2([cb[0]])); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		_r$1 = _r.Int(); /* */ $s = 2; case 2: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
		$24r = _r$1;
		$s = 3; case 3: return $24r;
		/* */ } return; } var $f = {$blk: requestAnimationFrame, $c: true, $r, $24r, _r, _r$1, callback, cb, $s};return $f;
	};
	RenderBody = function(body) {
		var {_r, _r$1, _r$2, _r$3, _selection, body, err, target, $s, $r, $c} = $restore(this, {body});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		_r = global().Get("document"); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		_r$1 = _r.Call("querySelector", new sliceType$2([new $String("body")])); /* */ $s = 2; case 2: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
		target = _r$1;
		_r$2 = renderIntoNode("RenderBody", target, body); /* */ $s = 3; case 3: if($c) { $c = false; _r$2 = _r$2.$blk(); } if (_r$2 && _r$2.$blk !== undefined) { break s; }
		err = _r$2;
		if (!($interfaceIsEqual(err, $ifaceNil))) {
			$panic(err);
		}
		/* */ if (!isTest) { $s = 4; continue; }
		/* */ $s = 5; continue;
		/* if (!isTest) { */ case 4:
			_r$3 = $select([]); /* */ $s = 6; case 6: if($c) { $c = false; _r$3 = _r$3.$blk(); } if (_r$3 && _r$3.$blk !== undefined) { break s; }
			_selection = _r$3;
		/* } */ case 5:
		$s = -1; return;
		/* */ } return; } var $f = {$blk: RenderBody, $c: true, $r, _r, _r$1, _r$2, _r$3, _selection, body, err, target, $s};return $f;
	};
	$pkg.RenderBody = RenderBody;
	ElementMismatchError.ptr.prototype.Error = function() {
		var e;
		e = this;
		return "vecty: " + e.method + ": expected Component.Render to return a \"" + e.want + "\", found \"" + e.got + "\"";
	};
	ElementMismatchError.prototype.Error = function() { return this.$val.Error(); };
	InvalidTargetError.ptr.prototype.Error = function() {
		var e;
		e = this;
		return "vecty: " + e.method + ": invalid target element is null or undefined";
	};
	InvalidTargetError.prototype.Error = function() { return this.$val.Error(); };
	renderIntoNode = function(methodName, node, c) {
		var {_r, _r$1, _r$2, _r$3, _r$4, _r$5, _r$6, _r$7, _r$8, _r$9, _tuple, _tuple$1, c, cb, doc, expectTag, m, methodName, nextRender, node, ok, pendingMounts, skip, x, x$1, $s, $r, $c} = $restore(this, {methodName, node, c});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		c = [c];
		cb = [cb];
		nextRender = [nextRender];
		node = [node];
		pendingMounts = [pendingMounts];
		_r = node[0].Truthy(); /* */ $s = 3; case 3: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		/* */ if (!_r) { $s = 1; continue; }
		/* */ $s = 2; continue;
		/* if (!_r) { */ case 1:
			$s = -1; return (x = new InvalidTargetError.ptr(methodName), new x.constructor.elem(x));
		/* } */ case 2:
		batch.scheduled = true;
		_r$1 = renderComponent(c[0], $ifaceNil); /* */ $s = 4; case 4: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
		_tuple = _r$1;
		nextRender[0] = _tuple[0];
		skip = _tuple[1];
		pendingMounts[0] = _tuple[2];
		if (skip) {
			$panic(new $String("vecty: " + methodName + ": Component.SkipRender illegally returned true"));
		}
		_r$2 = node[0].Get("nodeName"); /* */ $s = 5; case 5: if($c) { $c = false; _r$2 = _r$2.$blk(); } if (_r$2 && _r$2.$blk !== undefined) { break s; }
		_r$3 = _r$2.String(); /* */ $s = 6; case 6: if($c) { $c = false; _r$3 = _r$3.$blk(); } if (_r$3 && _r$3.$blk !== undefined) { break s; }
		_r$4 = toLower(_r$3); /* */ $s = 7; case 7: if($c) { $c = false; _r$4 = _r$4.$blk(); } if (_r$4 && _r$4.$blk !== undefined) { break s; }
		expectTag = _r$4;
		if (!(nextRender[0].tag === expectTag)) {
			$s = -1; return (x$1 = new ElementMismatchError.ptr(methodName, nextRender[0].tag, expectTag), new x$1.constructor.elem(x$1));
		}
		_r$5 = global().Get("document"); /* */ $s = 8; case 8: if($c) { $c = false; _r$5 = _r$5.$blk(); } if (_r$5 && _r$5.$blk !== undefined) { break s; }
		doc = _r$5;
		_r$6 = doc.Get("readyState"); /* */ $s = 11; case 11: if($c) { $c = false; _r$6 = _r$6.$blk(); } if (_r$6 && _r$6.$blk !== undefined) { break s; }
		_r$7 = _r$6.String(); /* */ $s = 12; case 12: if($c) { $c = false; _r$7 = _r$7.$blk(); } if (_r$7 && _r$7.$blk !== undefined) { break s; }
		/* */ if (_r$7 === "loading") { $s = 9; continue; }
		/* */ $s = 10; continue;
		/* if (_r$7 === "loading") { */ case 9:
			cb[0] = $ifaceNil;
			cb[0] = funcOf((function(c, cb, nextRender, node, pendingMounts) { return function $b(this$1, args) {
				var {_r$8, _tuple$1, args, m, ok, this$1, x$2, $s, $r, $c} = $restore(this, {this$1, args});
				/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
				$r = cb[0].Release(); /* */ $s = 1; case 1: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
				$r = replaceNode(nextRender[0].node, node[0]); /* */ $s = 2; case 2: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
				$r = mount(pendingMounts[0]); /* */ $s = 3; case 3: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
				_tuple$1 = $assertType(c[0], Mounter, true);
				m = _tuple$1[0];
				ok = _tuple$1[1];
				/* */ if (ok) { $s = 4; continue; }
				/* */ $s = 5; continue;
				/* if (ok) { */ case 4:
					$r = mount(new sliceType$4([m])); /* */ $s = 6; case 6: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
				/* } */ case 5:
				_r$8 = requestAnimationFrame($methodVal(batch, "render")); /* */ $s = 7; case 7: if($c) { $c = false; _r$8 = _r$8.$blk(); } if (_r$8 && _r$8.$blk !== undefined) { break s; }
				_r$8;
				$s = -1; return (x$2 = undefined$1(), new x$2.constructor.elem(x$2));
				/* */ } return; } var $f = {$blk: $b, $c: true, $r, _r$8, _tuple$1, args, m, ok, this$1, x$2, $s};return $f;
			}; })(c, cb, nextRender, node, pendingMounts));
			_r$8 = doc.Call("addEventListener", new sliceType$2([new $String("DOMContentLoaded"), cb[0]])); /* */ $s = 13; case 13: if($c) { $c = false; _r$8 = _r$8.$blk(); } if (_r$8 && _r$8.$blk !== undefined) { break s; }
			_r$8;
			$s = -1; return $ifaceNil;
		/* } */ case 10:
		$r = replaceNode(nextRender[0].node, node[0]); /* */ $s = 14; case 14: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = mount(pendingMounts[0]); /* */ $s = 15; case 15: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		_tuple$1 = $assertType(c[0], Mounter, true);
		m = _tuple$1[0];
		ok = _tuple$1[1];
		/* */ if (ok) { $s = 16; continue; }
		/* */ $s = 17; continue;
		/* if (ok) { */ case 16:
			$r = mount(new sliceType$4([m])); /* */ $s = 18; case 18: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		/* } */ case 17:
		_r$9 = requestAnimationFrame($methodVal(batch, "render")); /* */ $s = 19; case 19: if($c) { $c = false; _r$9 = _r$9.$blk(); } if (_r$9 && _r$9.$blk !== undefined) { break s; }
		_r$9;
		$s = -1; return $ifaceNil;
		/* */ } return; } var $f = {$blk: renderIntoNode, $c: true, $r, _r, _r$1, _r$2, _r$3, _r$4, _r$5, _r$6, _r$7, _r$8, _r$9, _tuple, _tuple$1, c, cb, doc, expectTag, m, methodName, nextRender, node, ok, pendingMounts, skip, x, x$1, $s};return $f;
	};
	ptrType$2.methods = [{prop: "PreventDefault", name: "PreventDefault", pkg: "", typ: $funcType([], [ptrType$2], false)}, {prop: "StopPropagation", name: "StopPropagation", pkg: "", typ: $funcType([], [ptrType$2], false)}, {prop: "Apply", name: "Apply", pkg: "", typ: $funcType([ptrType], [], false)}];
	markupFunc.methods = [{prop: "Apply", name: "Apply", pkg: "", typ: $funcType([ptrType], [], false)}];
	MarkupList.methods = [{prop: "Apply", name: "Apply", pkg: "", typ: $funcType([ptrType], [], false)}, {prop: "isMarkupOrChild", name: "isMarkupOrChild", pkg: "github.com/hexops/vecty", typ: $funcType([], [], false)}];
	ptrType$1.methods = [{prop: "String", name: "String", pkg: "", typ: $funcType([], [$String], false)}, {prop: "Release", name: "Release", pkg: "", typ: $funcType([], [], false)}];
	wrappedObject.methods = [{prop: "Set", name: "Set", pkg: "", typ: $funcType([$String, $emptyInterface], [], false)}, {prop: "Get", name: "Get", pkg: "", typ: $funcType([$String], [jsObject], false)}, {prop: "Delete", name: "Delete", pkg: "", typ: $funcType([$String], [], false)}, {prop: "Call", name: "Call", pkg: "", typ: $funcType([$String, sliceType$2], [jsObject], true)}, {prop: "String", name: "String", pkg: "", typ: $funcType([], [$String], false)}, {prop: "Truthy", name: "Truthy", pkg: "", typ: $funcType([], [$Bool], false)}, {prop: "IsUndefined", name: "IsUndefined", pkg: "", typ: $funcType([], [$Bool], false)}, {prop: "Equal", name: "Equal", pkg: "", typ: $funcType([jsObject], [$Bool], false)}, {prop: "Bool", name: "Bool", pkg: "", typ: $funcType([], [$Bool], false)}, {prop: "Int", name: "Int", pkg: "", typ: $funcType([], [$Int], false)}, {prop: "Float", name: "Float", pkg: "", typ: $funcType([], [$Float64], false)}];
	ptrType$4.methods = [{prop: "Context", name: "Context", pkg: "", typ: $funcType([], [ptrType$4], false)}, {prop: "isMarkupOrChild", name: "isMarkupOrChild", pkg: "github.com/hexops/vecty", typ: $funcType([], [], false)}, {prop: "isComponentOrHTML", name: "isComponentOrHTML", pkg: "github.com/hexops/vecty", typ: $funcType([], [], false)}];
	ptrType.methods = [{prop: "tinyGoCannotIterateNilMaps", name: "tinyGoCannotIterateNilMaps", pkg: "github.com/hexops/vecty", typ: $funcType([], [], false)}, {prop: "Node", name: "Node", pkg: "", typ: $funcType([], [js.Value], false)}, {prop: "Key", name: "Key", pkg: "", typ: $funcType([], [$emptyInterface], false)}, {prop: "isMarkupOrChild", name: "isMarkupOrChild", pkg: "github.com/hexops/vecty", typ: $funcType([], [], false)}, {prop: "isComponentOrHTML", name: "isComponentOrHTML", pkg: "github.com/hexops/vecty", typ: $funcType([], [], false)}, {prop: "createNode", name: "createNode", pkg: "github.com/hexops/vecty", typ: $funcType([], [], false)}, {prop: "reconcileText", name: "reconcileText", pkg: "github.com/hexops/vecty", typ: $funcType([ptrType], [], false)}, {prop: "reconcile", name: "reconcile", pkg: "github.com/hexops/vecty", typ: $funcType([ptrType], [sliceType$4], false)}, {prop: "reconcileProperties", name: "reconcileProperties", pkg: "github.com/hexops/vecty", typ: $funcType([ptrType], [], false)}, {prop: "removeProperties", name: "removeProperties", pkg: "github.com/hexops/vecty", typ: $funcType([ptrType], [], false)}, {prop: "reconcileChildren", name: "reconcileChildren", pkg: "github.com/hexops/vecty", typ: $funcType([ptrType], [sliceType$4], false)}, {prop: "removeChildren", name: "removeChildren", pkg: "github.com/hexops/vecty", typ: $funcType([sliceType$6], [], false)}, {prop: "firstChild", name: "firstChild", pkg: "github.com/hexops/vecty", typ: $funcType([], [jsObject], false)}, {prop: "nextSibling", name: "nextSibling", pkg: "github.com/hexops/vecty", typ: $funcType([], [jsObject], false)}, {prop: "removeChild", name: "removeChild", pkg: "github.com/hexops/vecty", typ: $funcType([ptrType], [], false)}, {prop: "appendChild", name: "appendChild", pkg: "github.com/hexops/vecty", typ: $funcType([ptrType], [], false)}, {prop: "insertBefore", name: "insertBefore", pkg: "github.com/hexops/vecty", typ: $funcType([jsObject, ptrType], [], false)}];
	List.methods = [{prop: "isMarkupOrChild", name: "isMarkupOrChild", pkg: "github.com/hexops/vecty", typ: $funcType([], [], false)}, {prop: "isComponentOrHTML", name: "isComponentOrHTML", pkg: "github.com/hexops/vecty", typ: $funcType([], [], false)}, {prop: "WithKey", name: "WithKey", pkg: "", typ: $funcType([$emptyInterface], [KeyedList], false)}];
	KeyedList.methods = [{prop: "isMarkupOrChild", name: "isMarkupOrChild", pkg: "github.com/hexops/vecty", typ: $funcType([], [], false)}, {prop: "isComponentOrHTML", name: "isComponentOrHTML", pkg: "github.com/hexops/vecty", typ: $funcType([], [], false)}, {prop: "Key", name: "Key", pkg: "", typ: $funcType([], [$emptyInterface], false)}, {prop: "reconcile", name: "reconcile", pkg: "github.com/hexops/vecty", typ: $funcType([ptrType, ComponentOrHTML], [sliceType$4], false)}, {prop: "remove", name: "remove", pkg: "github.com/hexops/vecty", typ: $funcType([ptrType], [], false)}];
	ptrType$5.methods = [{prop: "add", name: "add", pkg: "github.com/hexops/vecty", typ: $funcType([Component], [], false)}, {prop: "render", name: "render", pkg: "github.com/hexops/vecty", typ: $funcType([$Float64], [], false)}];
	ElementMismatchError.methods = [{prop: "Error", name: "Error", pkg: "", typ: $funcType([], [$String], false)}];
	InvalidTargetError.methods = [{prop: "Error", name: "Error", pkg: "", typ: $funcType([], [$String], false)}];
	EventListener.init("github.com/hexops/vecty", [{prop: "Name", name: "Name", embedded: false, exported: true, typ: $String, tag: ""}, {prop: "Listener", name: "Listener", embedded: false, exported: true, typ: funcType$1, tag: ""}, {prop: "callPreventDefault", name: "callPreventDefault", embedded: false, exported: false, typ: $Bool, tag: ""}, {prop: "callStopPropagation", name: "callStopPropagation", embedded: false, exported: false, typ: $Bool, tag: ""}, {prop: "wrapper", name: "wrapper", embedded: false, exported: false, typ: jsFunc, tag: ""}]);
	MarkupOrChild.init([{prop: "isMarkupOrChild", name: "isMarkupOrChild", pkg: "github.com/hexops/vecty", typ: $funcType([], [], false)}]);
	Applyer.init([{prop: "Apply", name: "Apply", pkg: "", typ: $funcType([ptrType], [], false)}]);
	markupFunc.init([ptrType], [], false);
	MarkupList.init("github.com/hexops/vecty", [{prop: "list", name: "list", embedded: false, exported: false, typ: sliceType$1, tag: ""}]);
	Event.init("", [{prop: "Value", name: "Value", embedded: true, exported: true, typ: js.Value, tag: ""}, {prop: "Target", name: "Target", embedded: false, exported: true, typ: js.Value, tag: ""}]);
	jsFuncImpl.init("github.com/hexops/vecty", [{prop: "f", name: "f", embedded: false, exported: false, typ: js.Func, tag: ""}, {prop: "goFunc", name: "goFunc", embedded: false, exported: false, typ: funcType$2, tag: ""}]);
	wrappedObject.init("github.com/hexops/vecty", [{prop: "j", name: "j", embedded: false, exported: false, typ: js.Value, tag: ""}]);
	Core.init("github.com/hexops/vecty", [{prop: "prevRenderComponent", name: "prevRenderComponent", embedded: false, exported: false, typ: Component, tag: ""}, {prop: "prevRender", name: "prevRender", embedded: false, exported: false, typ: ComponentOrHTML, tag: ""}, {prop: "mounted", name: "mounted", embedded: false, exported: false, typ: $Bool, tag: ""}, {prop: "unmounted", name: "unmounted", embedded: false, exported: false, typ: $Bool, tag: ""}]);
	Component.init([{prop: "Context", name: "Context", pkg: "", typ: $funcType([], [ptrType$4], false)}, {prop: "Render", name: "Render", pkg: "", typ: $funcType([], [ComponentOrHTML], false)}, {prop: "isComponentOrHTML", name: "isComponentOrHTML", pkg: "github.com/hexops/vecty", typ: $funcType([], [], false)}, {prop: "isMarkupOrChild", name: "isMarkupOrChild", pkg: "github.com/hexops/vecty", typ: $funcType([], [], false)}]);
	Copier.init([{prop: "Copy", name: "Copy", pkg: "", typ: $funcType([], [Component], false)}]);
	Mounter.init([{prop: "Mount", name: "Mount", pkg: "", typ: $funcType([], [], false)}]);
	Unmounter.init([{prop: "Unmount", name: "Unmount", pkg: "", typ: $funcType([], [], false)}]);
	Keyer.init([{prop: "Key", name: "Key", pkg: "", typ: $funcType([], [$emptyInterface], false)}]);
	ComponentOrHTML.init([{prop: "isComponentOrHTML", name: "isComponentOrHTML", pkg: "github.com/hexops/vecty", typ: $funcType([], [], false)}, {prop: "isMarkupOrChild", name: "isMarkupOrChild", pkg: "github.com/hexops/vecty", typ: $funcType([], [], false)}]);
	RenderSkipper.init([{prop: "SkipRender", name: "SkipRender", pkg: "", typ: $funcType([Component], [$Bool], false)}]);
	HTML.init("github.com/hexops/vecty", [{prop: "node", name: "node", embedded: false, exported: false, typ: jsObject, tag: ""}, {prop: "namespace", name: "namespace", embedded: false, exported: false, typ: $String, tag: ""}, {prop: "tag", name: "tag", embedded: false, exported: false, typ: $String, tag: ""}, {prop: "text", name: "text", embedded: false, exported: false, typ: $String, tag: ""}, {prop: "innerHTML", name: "innerHTML", embedded: false, exported: false, typ: $String, tag: ""}, {prop: "classes", name: "classes", embedded: false, exported: false, typ: mapType, tag: ""}, {prop: "styles", name: "styles", embedded: false, exported: false, typ: mapType$1, tag: ""}, {prop: "dataset", name: "dataset", embedded: false, exported: false, typ: mapType$1, tag: ""}, {prop: "properties", name: "properties", embedded: false, exported: false, typ: mapType$2, tag: ""}, {prop: "attributes", name: "attributes", embedded: false, exported: false, typ: mapType$2, tag: ""}, {prop: "eventListeners", name: "eventListeners", embedded: false, exported: false, typ: sliceType$5, tag: ""}, {prop: "children", name: "children", embedded: false, exported: false, typ: sliceType$6, tag: ""}, {prop: "key", name: "key", embedded: false, exported: false, typ: $emptyInterface, tag: ""}, {prop: "keyedChildren", name: "keyedChildren", embedded: false, exported: false, typ: mapType$3, tag: ""}, {prop: "insertBeforeNode", name: "insertBeforeNode", embedded: false, exported: false, typ: jsObject, tag: ""}, {prop: "lastRenderedChild", name: "lastRenderedChild", embedded: false, exported: false, typ: ptrType, tag: ""}]);
	List.init(ComponentOrHTML);
	KeyedList.init("github.com/hexops/vecty", [{prop: "html", name: "html", embedded: false, exported: false, typ: ptrType, tag: ""}, {prop: "key", name: "key", embedded: false, exported: false, typ: $emptyInterface, tag: ""}]);
	batchRenderer.init("github.com/hexops/vecty", [{prop: "batch", name: "batch", embedded: false, exported: false, typ: sliceType, tag: ""}, {prop: "idx", name: "idx", embedded: false, exported: false, typ: mapType$4, tag: ""}, {prop: "scheduled", name: "scheduled", embedded: false, exported: false, typ: $Bool, tag: ""}]);
	ElementMismatchError.init("github.com/hexops/vecty", [{prop: "method", name: "method", embedded: false, exported: false, typ: $String, tag: ""}, {prop: "got", name: "got", embedded: false, exported: false, typ: $String, tag: ""}, {prop: "want", name: "want", embedded: false, exported: false, typ: $String, tag: ""}]);
	InvalidTargetError.init("github.com/hexops/vecty", [{prop: "method", name: "method", embedded: false, exported: false, typ: $String, tag: ""}]);
	jsFunc.init([{prop: "Release", name: "Release", pkg: "", typ: $funcType([], [], false)}]);
	jsObject.init([{prop: "Bool", name: "Bool", pkg: "", typ: $funcType([], [$Bool], false)}, {prop: "Call", name: "Call", pkg: "", typ: $funcType([$String, sliceType$2], [jsObject], true)}, {prop: "Delete", name: "Delete", pkg: "", typ: $funcType([$String], [], false)}, {prop: "Equal", name: "Equal", pkg: "", typ: $funcType([jsObject], [$Bool], false)}, {prop: "Float", name: "Float", pkg: "", typ: $funcType([], [$Float64], false)}, {prop: "Get", name: "Get", pkg: "", typ: $funcType([$String], [jsObject], false)}, {prop: "Int", name: "Int", pkg: "", typ: $funcType([], [$Int], false)}, {prop: "IsUndefined", name: "IsUndefined", pkg: "", typ: $funcType([], [$Bool], false)}, {prop: "Set", name: "Set", pkg: "", typ: $funcType([$String, $emptyInterface], [], false)}, {prop: "String", name: "String", pkg: "", typ: $funcType([], [$String], false)}, {prop: "Truthy", name: "Truthy", pkg: "", typ: $funcType([], [$Bool], false)}]);
	$init = function() {
		$pkg.$init = function() {};
		/* */ var $f, $c = false, $s = 0, $r; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		$r = reflect.$init(); /* */ $s = 1; case 1: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = js.$init(); /* */ $s = 2; case 2: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		globalValue = $ifaceNil;
		isTest = false;
		batch = new batchRenderer.ptr(sliceType.nil, new $global.Map(), false);
		$r = init(); /* */ $s = 3; case 3: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		/* */ } return; } if ($f === undefined) { $f = { $blk: $init }; } $f.$s = $s; $f.$r = $r; return $f;
	};
	$pkg.$init = $init;
	return $pkg;
})();
$packages["github.com/hexops/vecty/elem"] = (function() {
	var $pkg = {}, $init, vecty, Div;
	vecty = $packages["github.com/hexops/vecty"];
	Div = function(markup) {
		var {$24r, _r, markup, $s, $r, $c} = $restore(this, {markup});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		_r = vecty.Tag("div", markup); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		$24r = _r;
		$s = 2; case 2: return $24r;
		/* */ } return; } var $f = {$blk: Div, $c: true, $r, $24r, _r, markup, $s};return $f;
	};
	$pkg.Div = Div;
	$init = function() {
		$pkg.$init = function() {};
		/* */ var $f, $c = false, $s = 0, $r; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		$r = vecty.$init(); /* */ $s = 1; case 1: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		/* */ } return; } if ($f === undefined) { $f = { $blk: $init }; } $f.$s = $s; $f.$r = $r; return $f;
	};
	$pkg.$init = $init;
	return $pkg;
})();
$packages["mapassist/mymodule"] = (function() {
	var $pkg = {}, $init, js, vecty, elem, MyComponent, sliceType, sliceType$1, sliceType$2, funcType, ptrType, main;
	js = $packages["github.com/gopherjs/gopherjs/js"];
	vecty = $packages["github.com/hexops/vecty"];
	elem = $packages["github.com/hexops/vecty/elem"];
	MyComponent = $pkg.MyComponent = $newType(0, $kindStruct, "main.MyComponent", true, "mapassist/mymodule", true, function(Core_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.Core = new vecty.Core.ptr($ifaceNil, $ifaceNil, false, false);
			return;
		}
		this.Core = Core_;
	});
	sliceType = $sliceType(vecty.Applyer);
	sliceType$1 = $sliceType(vecty.MarkupOrChild);
	sliceType$2 = $sliceType($emptyInterface);
	funcType = $funcType([], [], false);
	ptrType = $ptrType(MyComponent);
	MyComponent.ptr.prototype.Render = function() {
		var {$24r, _r, mc, x, $s, $r, $c} = $restore(this, {});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		mc = this;
		_r = elem.Div(new sliceType$1([(x = vecty.Markup(new sliceType([vecty.Attribute("id", new $String("map")), vecty.Style("width", "100%"), vecty.Style("height", "500px")])), new x.constructor.elem(x))])); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		$24r = _r;
		$s = 2; case 2: return $24r;
		/* */ } return; } var $f = {$blk: MyComponent.ptr.prototype.Render, $c: true, $r, $24r, _r, mc, x, $s};return $f;
	};
	MyComponent.prototype.Render = function() { return this.$val.Render(); };
	main = function() {
		$global.addEventListener($externalize("DOMContentLoaded", $String), $externalize((function() {
			$go((function $b() {
				var {leaflet, osm_map, tileLayer, $s, $r, $c} = $restore(this, {});
				/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
				leaflet = $global.L;
				osm_map = leaflet.map($externalize("map", $String));
				osm_map.setView($externalize(new sliceType$2([new $Float64(51.505), new $Float64(-0.09)]), sliceType$2), 13);
				tileLayer = leaflet.tileLayer($externalize("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", $String), osm_map, osm_map);
				tileLayer.addTo(osm_map);
				$r = vecty.RenderBody(new MyComponent.ptr(new vecty.Core.ptr($ifaceNil, $ifaceNil, false, false))); /* */ $s = 1; case 1: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
				$s = -1; return;
				/* */ } return; } var $f = {$blk: $b, $c: true, $r, leaflet, osm_map, tileLayer, $s};return $f;
			}), []);
		}), funcType));
	};
	ptrType.methods = [{prop: "Render", name: "Render", pkg: "", typ: $funcType([], [vecty.ComponentOrHTML], false)}];
	MyComponent.init("", [{prop: "Core", name: "Core", embedded: true, exported: true, typ: vecty.Core, tag: ""}]);
	$init = function() {
		$pkg.$init = function() {};
		/* */ var $f, $c = false, $s = 0, $r; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		$r = js.$init(); /* */ $s = 1; case 1: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = vecty.$init(); /* */ $s = 2; case 2: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = elem.$init(); /* */ $s = 3; case 3: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		if ($pkg === $mainPkg) {
			main();
			$mainFinished = true;
		}
		/* */ } return; } if ($f === undefined) { $f = { $blk: $init }; } $f.$s = $s; $f.$r = $r; return $f;
	};
	$pkg.$init = $init;
	return $pkg;
})();
$synthesizeMethods();
$initAllLinknames();
var $mainPkg = $packages["mapassist/mymodule"];
$packages["runtime"].$init();
$go($mainPkg.$init, []);
$flushConsole();

}).call(this);
//# sourceMappingURL=mapassist.js.map

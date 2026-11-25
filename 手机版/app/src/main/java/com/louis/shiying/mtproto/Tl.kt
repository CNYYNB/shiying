package com.louis.shiying.mtproto

import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.zip.GZIPInputStream

/**
 * Schema-driven TL (Type Language) serialization for MTProto.
 *
 * Instead of generating thousands of classes, the schema text (assets/telegram/api.tl + schema.tl, the same layer GramJS uses)
 * is parsed at run time and every object is a [TlObj]: the constructor's predicate name ("message", "channel",
 * "messages.channelMessages" …) plus a field map with the schema's field names. Values:
 * int → Int, long → Long, double → Double, string → String (or ByteArray when [TlReader.rawStrings]), bytes → ByteArray,
 * int128/int256 → ByteArray, Bool → Boolean, `true` flags → Boolean, Vector → List, objects → TlObj.
 */
class TlObj(val type: String, val f: MutableMap<String, Any?> = LinkedHashMap()) {
    operator fun get(k: String): Any? = f[k]
    operator fun set(k: String, v: Any?) { f[k] = v }
    fun obj(k: String): TlObj? = f[k] as? TlObj
    fun int(k: String): Int? = (f[k] as? Number)?.toInt()
    fun long(k: String): Long? = (f[k] as? Number)?.toLong()
    fun str(k: String): String? = when (val v = f[k]) { is String -> v; is ByteArray -> String(v, Charsets.UTF_8); else -> null }
    fun bytes(k: String): ByteArray? = when (val v = f[k]) { is ByteArray -> v; is String -> v.toByteArray(Charsets.UTF_8); else -> null }
    fun flag(k: String): Boolean = f[k] == true
    @Suppress("UNCHECKED_CAST")
    fun list(k: String): List<Any?> = (f[k] as? List<Any?>) ?: emptyList()
    fun objs(k: String): List<TlObj> = list(k).filterIsInstance<TlObj>()
    fun isA(vararg names: String) = type in names
    override fun toString(): String = "TlObj($type ${f.keys})"

    companion object {
        /** TlObj("name", "a" to 1, …) */
        fun of(type: String, vararg kv: Pair<String, Any?>): TlObj = TlObj(type, linkedMapOf(*kv))
    }
}

class TlParam(val name: String, val type: String, val flagField: String?, val flagBit: Int) {
    val isFlags get() = type == "#"
}

class TlCombinator(val name: String, val id: Int, val params: List<TlParam>, val result: String, val isFunction: Boolean)

class TlException(msg: String) : Exception(msg)

/** Parsed schema. Several schema texts can be merged (MTProto service schema + API schema). */
class TlSchema(vararg texts: String) {
    val byId = HashMap<Int, TlCombinator>()
    val byName = HashMap<String, TlCombinator>()

    private val lineRe = Regex("""^([A-Za-z_][\w.]*)#([0-9a-fA-F]{1,8})\s*(.*?)\s*=\s*([^;]+);\s*$""")

    init { texts.forEach { load(it) } }

    private fun load(text: String) {
        var functions = false
        for (raw in text.lineSequence()) {
            val line = raw.trim()
            if (line.isEmpty() || line.startsWith("//")) continue
            if (line == "---functions---") { functions = true; continue }
            if (line == "---types---") { functions = false; continue }
            val m = lineRe.find(line) ?: continue
            val name = m.groupValues[1]
            if (name == "vector") continue
            val id = java.lang.Long.parseLong(m.groupValues[2], 16).toInt()
            val params = ArrayList<TlParam>()
            for (p in m.groupValues[3].split(Regex("\\s+")).filter { it.isNotEmpty() }) {
                if (p.startsWith("{")) continue // {X:Type}
                val c = p.indexOf(':'); if (c < 0) continue
                val pn = p.substring(0, c)
                var t = p.substring(c + 1)
                var ff: String? = null; var bit = -1
                val q = t.indexOf('?')
                if (q > 0) {
                    val cond = t.substring(0, q); t = t.substring(q + 1)
                    val dot = cond.indexOf('.')
                    ff = cond.substring(0, dot); bit = cond.substring(dot + 1).toInt()
                }
                params += TlParam(pn, t, ff, bit)
            }
            val cmb = TlCombinator(name, id, params, m.groupValues[4].trim(), functions)
            byId[id] = cmb
            byName[name] = cmb
        }
    }

    fun combinator(name: String): TlCombinator = byName[name] ?: throw TlException("TL 里没有 $name")

    /** What an RPC call returns (descends into invokeWithLayer / initConnection's `!X` query). */
    fun returnType(req: TlObj): String {
        val c = combinator(req.type)
        if (c.result == "X") {
            val q = c.params.firstOrNull { it.type == "!X" }?.let { req[it.name] as? TlObj } ?: return "Object"
            return returnType(q)
        }
        return c.result
    }

    fun serialize(obj: TlObj): ByteArray { val w = TlWriter(this); w.obj(obj); return w.bytes() }
}

class TlWriter(private val schema: TlSchema) {
    private val out = ByteArrayOutputStream()
    private val b8 = ByteBuffer.allocate(8).order(ByteOrder.LITTLE_ENDIAN)

    fun bytes(): ByteArray = out.toByteArray()
    fun int(v: Int) { b8.clear(); b8.putInt(v); out.write(b8.array(), 0, 4) }
    fun long(v: Long) { b8.clear(); b8.putLong(v); out.write(b8.array(), 0, 8) }
    fun double(v: Double) { b8.clear(); b8.putDouble(v); out.write(b8.array(), 0, 8) }
    fun raw(b: ByteArray) { out.write(b) }

    fun tlBytes(b: ByteArray) {
        val n = b.size
        if (n <= 253) {
            out.write(n); out.write(b)
            val pad = (4 - (n + 1) % 4) % 4
            repeat(pad) { out.write(0) }
        } else {
            out.write(254); out.write(n and 0xff); out.write((n shr 8) and 0xff); out.write((n shr 16) and 0xff)
            out.write(b)
            val pad = (4 - n % 4) % 4
            repeat(pad) { out.write(0) }
        }
    }

    /** Boxed object (constructor id + fields). A ByteArray is written as already-serialized boxed data. */
    fun obj(o: Any?) {
        when (o) {
            is TlObj -> { val c = schema.combinator(o.type); int(c.id); fields(c, o) }
            is ByteArray -> raw(o)
            is Boolean -> int(if (o) BOOL_TRUE else BOOL_FALSE)
            else -> throw TlException("不能序列化 ${o?.javaClass?.simpleName}")
        }
    }

    private fun fields(c: TlCombinator, o: TlObj) {
        for (p in c.params) {
            if (p.isFlags) {
                var flags = 0
                for (q in c.params) if (q.flagField == p.name) {
                    val v = o[q.name]
                    val set = if (q.type == "true") v == true else v != null
                    if (set) flags = flags or (1 shl q.flagBit)
                }
                int(flags); continue
            }
            val v = o[p.name]
            if (p.flagField != null) {
                if (p.type == "true" || v == null) continue
            } else if (v == null && p.type != "true") throw TlException("${c.name}.${p.name} 没有值")
            value(p.type, v)
        }
    }

    fun value(type: String, v: Any?) {
        when {
            type == "int" -> int((v as Number).toInt())
            type == "long" -> long((v as Number).toLong())
            type == "double" -> double((v as Number).toDouble())
            type == "string" -> tlBytes(if (v is ByteArray) v else (v as String).toByteArray(Charsets.UTF_8))
            type == "bytes" -> tlBytes(if (v is String) v.toByteArray(Charsets.UTF_8) else v as ByteArray)
            type == "int128" || type == "int256" -> raw(v as ByteArray)
            type == "Bool" -> int(if (v == true) BOOL_TRUE else BOOL_FALSE)
            type == "true" -> {}
            type.startsWith("Vector<") -> { int(VECTOR); vector(type.substring(7, type.length - 1), v as List<*>) }
            type.startsWith("vector<") -> vector(type.substring(7, type.length - 1), v as List<*>)
            type.startsWith("%") -> fields(schema.combinator(type.substring(1).replaceFirstChar { it.lowercase() }), v as TlObj)
            type[0].isLowerCase() && !type.contains('.') || (type.contains('.') && type.substringAfterLast('.')[0].isLowerCase()) ->
                fields(schema.combinator(type), v as TlObj) // bare constructor
            else -> obj(v) // boxed type, !X, Object
        }
    }

    private fun vector(elem: String, l: List<*>) { int(l.size); l.forEach { value(elem, it) } }

    companion object {
        const val VECTOR = 0x1cb5c415
        const val BOOL_TRUE = 0x997275b5.toInt()
        const val BOOL_FALSE = 0xbc799737.toInt()
        const val GZIP = 0x3072cfa1
    }
}

class TlReader(private val schema: TlSchema, private val buf: ByteBuffer, var rawStrings: Boolean = false) {
    constructor(schema: TlSchema, b: ByteArray, rawStrings: Boolean = false) : this(schema, ByteBuffer.wrap(b).order(ByteOrder.LITTLE_ENDIAN), rawStrings)

    val remaining get() = buf.remaining()
    val position get() = buf.position()
    fun int(): Int = buf.int
    fun long(): Long = buf.long
    fun double(): Double = buf.double
    fun raw(n: Int): ByteArray { if (n > buf.remaining() || n < 0) throw TlException("TL 数据不完整"); val b = ByteArray(n); buf.get(b); return b }

    fun tlBytes(): ByteArray {
        var n = buf.get().toInt() and 0xff
        val head: Int
        if (n == 254) {
            n = (buf.get().toInt() and 0xff) or ((buf.get().toInt() and 0xff) shl 8) or ((buf.get().toInt() and 0xff) shl 16)
            head = 4
        } else head = 1
        val b = raw(n)
        val pad = (4 - (n + head) % 4) % 4
        buf.position(buf.position() + pad)
        return b
    }

    /** Boxed object of unknown type (or the given [expected] type, needed for Vector results). */
    fun obj(expected: String? = null): Any? {
        val id = int()
        if (id != TlWriter.GZIP && expected != null && (expected.startsWith("Vector<") || expected in PRIMS)) {
            buf.position(buf.position() - 4); return value(expected)
        }
        return when (id) {
            TlWriter.BOOL_TRUE -> true
            TlWriter.BOOL_FALSE -> false
            TlWriter.GZIP -> {
                val data = GZIPInputStream(tlBytes().inputStream()).readBytes()
                TlReader(schema, data, rawStrings).obj(expected)
            }
            TlWriter.VECTOR -> { // vector of unknown elements: assume boxed objects
                val n = int(); (0 until n).map { obj() }
            }
            else -> {
                val c = schema.byId[id] ?: throw TlException("未知的 TL 构造 0x%08x".format(id))
                fields(c)
            }
        }
    }

    fun fields(c: TlCombinator): TlObj {
        val o = TlObj(c.name)
        val flags = HashMap<String, Int>()
        for (p in c.params) {
            if (p.isFlags) { val v = int(); flags[p.name] = v; o[p.name] = v; continue }
            if (p.flagField != null) {
                val on = ((flags[p.flagField] ?: 0) shr p.flagBit) and 1 == 1
                if (p.type == "true") { o[p.name] = on; continue }
                if (!on) continue
            }
            o[p.name] = value(p.type)
        }
        return o
    }

    fun value(type: String): Any? = when {
        type == "int" -> int()
        type == "long" -> long()
        type == "double" -> double()
        type == "string" -> tlBytes().let { if (rawStrings) it else String(it, Charsets.UTF_8) }
        type == "bytes" -> tlBytes()
        type == "int128" -> raw(16)
        type == "int256" -> raw(32)
        type == "Bool" -> int() == TlWriter.BOOL_TRUE
        type == "true" -> true
        type.startsWith("Vector<") -> {
            val id = int()
            if (id != TlWriter.VECTOR) throw TlException("这里应该是 Vector")
            vector(type.substring(7, type.length - 1))
        }
        type.startsWith("vector<") -> vector(type.substring(7, type.length - 1))
        type.startsWith("%") -> fields(schema.combinator(type.substring(1).replaceFirstChar { it.lowercase() }))
        type[0].isLowerCase() && schema.byName.containsKey(type) -> fields(schema.combinator(type))
        type.contains('.') && type.substringAfterLast('.')[0].isLowerCase() && schema.byName.containsKey(type) -> fields(schema.combinator(type))
        else -> obj()
    }

    private fun vector(elem: String): List<Any?> { val n = int(); return (0 until n).map { value(elem) } }

    companion object { private val PRIMS = setOf("int", "long", "double", "string", "bytes", "Bool", "int128", "int256") }
}

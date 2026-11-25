package com.louis.shiying.mtproto

import java.math.BigInteger
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec

/** Crypto primitives for MTProto 2.0 (JCA only: AES-ECB → IGE, AES-CTR, SHA-1/256, HMAC-SHA512, BigInteger). */
object Crypto {
    val random = SecureRandom()

    fun randomBytes(n: Int): ByteArray = ByteArray(n).also { random.nextBytes(it) }
    fun sha1(vararg parts: ByteArray): ByteArray = MessageDigest.getInstance("SHA-1").run { parts.forEach { update(it) }; digest() }
    fun sha256(vararg parts: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").run { parts.forEach { update(it) }; digest() }

    fun concat(vararg parts: ByteArray): ByteArray {
        val out = ByteArray(parts.sumOf { it.size }); var o = 0
        for (p in parts) { System.arraycopy(p, 0, out, o, p.size); o += p.size }
        return out
    }

    fun xor(a: ByteArray, b: ByteArray): ByteArray = ByteArray(minOf(a.size, b.size)) { (a[it].toInt() xor b[it].toInt()).toByte() }

    /** Unsigned big-endian bytes, left-padded (or trimmed) to [size] (size 0 = minimal length). */
    fun toBytes(v: BigInteger, size: Int = 0): ByteArray {
        var b = v.toByteArray()
        if (b.size > 1 && b[0] == 0.toByte()) b = b.copyOfRange(1, b.size)
        if (size == 0 || b.size == size) return b
        if (b.size > size) return b.copyOfRange(b.size - size, b.size)
        return ByteArray(size - b.size) + b
    }

    fun big(b: ByteArray): BigInteger = BigInteger(1, b)

    // ------------------------------------------------------------------ AES-256-IGE

    fun igeEncrypt(data: ByteArray, key: ByteArray, iv: ByteArray): ByteArray = ige(data, key, iv, true)
    fun igeDecrypt(data: ByteArray, key: ByteArray, iv: ByteArray): ByteArray = ige(data, key, iv, false)

    private fun ige(data: ByteArray, key: ByteArray, iv: ByteArray, enc: Boolean): ByteArray {
        require(data.size % 16 == 0) { "IGE 数据长度必须是 16 的倍数" }
        val c = Cipher.getInstance("AES/ECB/NoPadding")
        c.init(if (enc) Cipher.ENCRYPT_MODE else Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"))
        // encrypt: c_i = E(p_i ^ c_{i-1}) ^ p_{i-1}, c_0 = iv[0:16], p_0 = iv[16:32]
        // decrypt: p_i = D(c_i ^ p_{i-1}) ^ c_{i-1}
        var prevX = iv.copyOfRange(0, 16)   // enc: previous ciphertext; dec: previous ciphertext
        var prevY = iv.copyOfRange(16, 32)  // enc: previous plaintext;  dec: previous plaintext
        val out = ByteArray(data.size)
        val blk = ByteArray(16)
        for (i in data.indices step 16) {
            val cur = data.copyOfRange(i, i + 16)
            if (enc) {
                for (j in 0 until 16) blk[j] = (cur[j].toInt() xor prevX[j].toInt()).toByte()
                val e = c.doFinal(blk)
                for (j in 0 until 16) e[j] = (e[j].toInt() xor prevY[j].toInt()).toByte()
                System.arraycopy(e, 0, out, i, 16)
                prevX = e; prevY = cur
            } else {
                for (j in 0 until 16) blk[j] = (cur[j].toInt() xor prevY[j].toInt()).toByte()
                val d = c.doFinal(blk)
                for (j in 0 until 16) d[j] = (d[j].toInt() xor prevX[j].toInt()).toByte()
                System.arraycopy(d, 0, out, i, 16)
                prevX = cur; prevY = d
            }
        }
        return out
    }

    /** Streaming AES-256-CTR (obfuscated transport). */
    class Ctr(key: ByteArray, iv: ByteArray) {
        private val c = Cipher.getInstance("AES/CTR/NoPadding").apply { init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), IvParameterSpec(iv)) }
        fun update(b: ByteArray): ByteArray = c.update(b) ?: ByteArray(0)
    }

    // ------------------------------------------------------------------ PQ factorization (Pollard–Brent)

    fun factorize(pq: BigInteger): Pair<BigInteger, BigInteger> {
        if (pq.testBit(0).not()) return BigInteger.valueOf(2).let { it to pq.divide(it) }
        val one = BigInteger.ONE
        for (attempt in 0 until 50) {
            var y = BigInteger(pq.bitLength(), random).mod(pq.subtract(one)).add(one)
            val c = BigInteger(pq.bitLength(), random).mod(pq.subtract(one)).add(one)
            val m = BigInteger(pq.bitLength(), random).mod(pq.subtract(one)).add(one)
            var g = one; var r = one; var q = one
            var x = y; var ys = y
            while (g == one) {
                x = y
                var i = BigInteger.ZERO
                while (i < r) { y = y.multiply(y).mod(pq).add(c).mod(pq); i = i.add(one) }
                var k = BigInteger.ZERO
                while (k < r && g == one) {
                    ys = y
                    val lim = m.min(r.subtract(k))
                    var j = BigInteger.ZERO
                    while (j < lim) {
                        y = y.multiply(y).mod(pq).add(c).mod(pq)
                        q = q.multiply(x.subtract(y).abs()).mod(pq)
                        j = j.add(one)
                    }
                    g = q.gcd(pq)
                    k = k.add(m)
                }
                r = r.shiftLeft(1)
            }
            if (g == pq) {
                while (true) {
                    ys = ys.multiply(ys).mod(pq).add(c).mod(pq)
                    g = x.subtract(ys).abs().gcd(pq)
                    if (g > one) break
                }
            }
            if (g != pq && g > one) {
                val other = pq.divide(g)
                return if (g < other) g to other else other to g
            }
        }
        throw IllegalStateException("pq 分解失败")
    }

    // ------------------------------------------------------------------ RSA server keys (same as GramJS / Telegram clients)

    class RsaKey(val fingerprint: Long, val n: BigInteger, val e: BigInteger = BigInteger.valueOf(65537))

    val SERVER_KEYS = listOf(
        RsaKey(-3414540481677951611L, BigInteger(
            "29379598170669337022986177149456128565388431120058863768162556424047512191330847455146576344487764408661" +
            "7018905050662086321691122695810637742931025773084905312827484659861398809772803022427728329725394035313" +
            "1601087040128764276300913615673433953804241938872277735713448774616909353909385025124389718892873590338" +
            "9451772730245253062963384108812842079887538976360465290946139638691491496062099570836476454855996319192" +
            "7476636159556337780348971409825174464053344237013591088101820977494672105095842934280766545733848288095" +
            "74217079944388301239431309115013843331317877374435868468779972014486325557807783825502498215169806323")),
        RsaKey(-5595554452916591101L, BigInteger(
            "2534288944884041556497168959071347320689884775908477905258202659454602246385394058588521595116849196570822" +
            "26493991806038180742006204637761354248846321625124031637930839216416315647409595294193595958529411668489405859523" +
            "37613333022396096584117954892216031229237302943701877588456738335398602461675225081791820393153757504952636234951" +
            "32323782003654358104782690612092797248736680529211579223142368426126233039432475078545094258975175539015664775146" +
            "07193514399690599495696153028090507215003302390050778898553239175099482557220816446894421272976054225797071426466" +
            "60768825302832201908302295573257427896031830742328565032949")),
    )

    /** RSA_PAD (p_q_inner_data encryption, https://core.telegram.org/mtproto/auth_key step 4.1). */
    fun rsaPad(data: ByteArray, key: RsaKey): ByteArray {
        require(data.size <= 144)
        val withPad = data + randomBytes(192 - data.size)
        val reversed = withPad.reversedArray()
        repeat(20) {
            val tempKey = randomBytes(32)
            val dataWithHash = reversed + sha256(tempKey, withPad)
            val aesEnc = igeEncrypt(dataWithHash, tempKey, ByteArray(32))
            val tempKeyXor = xor(tempKey, sha256(aesEnc))
            val keyAesEnc = tempKeyXor + aesEnc
            val v = big(keyAesEnc)
            if (v >= key.n) return@repeat
            return toBytes(v.modPow(key.e, key.n), 256)
        }
        throw IllegalStateException("RSA 加密失败")
    }

    // ------------------------------------------------------------------ PBKDF2-HMAC-SHA512 (manual: the JCA name needs API 26)

    fun pbkdf2Sha512(password: ByteArray, salt: ByteArray, iterations: Int, len: Int = 64): ByteArray {
        val mac = Mac.getInstance("HmacSHA512")
        mac.init(SecretKeySpec(password, "HmacSHA512"))
        val out = ByteArray(len)
        var block = 1; var off = 0
        while (off < len) {
            mac.update(salt)
            mac.update(byteArrayOf((block ushr 24).toByte(), (block ushr 16).toByte(), (block ushr 8).toByte(), block.toByte()))
            var u = mac.doFinal()
            val t = u.copyOf()
            for (i in 1 until iterations) {
                u = mac.doFinal(u)
                for (j in t.indices) t[j] = (t[j].toInt() xor u[j].toInt()).toByte()
            }
            val n = minOf(t.size, len - off)
            System.arraycopy(t, 0, out, off, n)
            off += n; block++
        }
        return out
    }

    // ------------------------------------------------------------------ SRP (2FA password), same algorithm as GramJS computeCheck

    private val GOOD_PRIME = BigInteger(
        "c71caeb9c6b1c9048e6c522f70f13f73980d40238e3e21c14934d037563d930f48198a0aa7c14058229493d22530f4dbfa336f6e0ac925139543aed44cce7c3720fd51f69458705ac68cd4fe6b6b13abdc9746512969328454f18faf8c595f642477fe96bb2a941d5bcd1d4ac8cc49880708fa9b378e3c4f3a9060bee67cf9a4a4a695811051907e162753b56b0f6b410dba74d8a84b2a14b3144e0ef1284754fd17ed950d5965b4b9dd46582db1178d169c6bc465b0d6ff9ca3928fef5b9ae4e418fc15e83ebea0f87fa9ff5eed70050ded2849f47bf959d956850ce929851f0d8115f635b105ee2e4e15d04b2454bf6f4fadf034b10403119cd8e3b92fcc5b", 16)

    class SrpAnswer(val srpId: Long, val a: ByteArray, val m1: ByteArray)

    class PasswordError(msg: String) : Exception(msg)

    private fun pad256(b: ByteArray) = if (b.size >= 256) b else ByteArray(256 - b.size) + b

    fun passwordHash(salt1: ByteArray, salt2: ByteArray, password: String): ByteArray {
        val pw = password.toByteArray(Charsets.UTF_8)
        val h1 = sha256(salt1, pw, salt1)
        val h2 = sha256(salt2, h1, salt2)
        val h3 = pbkdf2Sha512(h2, salt1, 100000)
        return sha256(salt2, h3, salt2)
    }

    /**
     * account.password (passwordKdfAlgoSHA256SHA256PBKDF2HMACSHA512iter100000SHA256ModPow) → inputCheckPasswordSRP values.
     * [randomA] only for tests (256 bytes).
     */
    fun srpCheck(salt1: ByteArray, salt2: ByteArray, g: Int, pBytes: ByteArray, srpB: ByteArray, srpId: Long, password: String,
                 randomA: (() -> ByteArray)? = null): SrpAnswer {
        val p = big(pBytes)
        if (p != GOOD_PRIME || g !in listOf(3, 4, 5, 7)) throw PasswordError("bad p/g in password")
        val bigB = big(srpB)
        if (bigB.signum() <= 0 || p.subtract(bigB).signum() <= 0) throw PasswordError("bad b in check")
        val x = big(passwordHash(salt1, salt2, password))
        val gBig = BigInteger.valueOf(g.toLong())
        val pForHash = pad256(pBytes)
        val gForHash = toBytes(gBig, 256)
        val bForHash = pad256(srpB)
        val gX = gBig.modPow(x, p)
        val k = big(sha256(pForHash, gForHash))
        val kgX = k.multiply(gX).mod(p)
        fun goodModExp(v: BigInteger): Boolean {
            val diff = p.subtract(v)
            return !(diff.signum() < 0 || diff.bitLength() < 2048 - 64 || v.bitLength() < 2048 - 64 || (v.bitLength() + 7) / 8 > 256)
        }
        var a: BigInteger; var aForHash: ByteArray; var u: BigInteger
        while (true) {
            a = big(randomA?.invoke() ?: randomBytes(256))
            val bigA = gBig.modPow(a, p)
            if (!goodModExp(bigA)) continue
            aForHash = toBytes(bigA, 256)
            u = big(sha256(aForHash, bForHash))
            if (u.signum() > 0) break
        }
        val gB = bigB.subtract(kgX).mod(p)
        if (!goodModExp(gB)) throw PasswordError("bad gB")
        val s = gB.modPow(a.add(u.multiply(x)), p)
        val kk = sha256(toBytes(s, 256))
        val m1 = sha256(xor(sha256(pForHash), sha256(gForHash)), sha256(salt1), sha256(salt2), aForHash, bForHash, kk)
        return SrpAnswer(srpId, aForHash, m1)
    }
}

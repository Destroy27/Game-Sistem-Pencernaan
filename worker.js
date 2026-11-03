// Cloudflare Worker + D1 untuk Petualangan Makanan.
// Alur: guru daftar gratis, lalu kelola murid, soal, dan token akses harian untuk siswa.

const AMBANG_GAGAL = 30;   // % jawaban 0 poin per organ, materi perlu diulas
const AMBANG_RATA = 250;   // rata-rata skor per siswa di bawah ini perlu pendampingan
const MIN_SESI = 2;        // minimal sesi sebelum siswa disorot
// Alamat halaman guru (ganti USERNAME dan NAMA-REPO dengan milikmu).
const ADMIN_URL = 'https://destroy27.github.io/Game-Sistem-Pencernaan/admin.html';
async function sha256(s) {
  const b = new TextEncoder().encode(s);
  const h = await crypto.subtle.digest('SHA-256', b);
  return [...new Uint8Array(h)].map(x => x.toString(16).padStart(2, '0')).join('');
}

function kodeAcak(n = 4) {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return [...a].map(x => abc[x % abc.length]).join('');
}

export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    const origin = env.ALLOWED_ORIGIN || '*';
    const h = {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST,GET,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
      'Access-Control-Max-Age': '86400',
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json'
    };
    const J = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: h });
    const cut = (s, n) => String(s ?? '').slice(0, n);

    if (req.method === 'OPTIONS') return new Response(null, { headers: h });

    // Cek origin: browser dari domain lain ditolak.
    const reqOrigin = req.headers.get('Origin');
    if (origin !== '*' && reqOrigin && reqOrigin !== origin) return J({ e: 'origin' }, 403);

    async function tokenTenant(kode) {
      if (!kode) return '';
      try {
        const r = await env.DB.prepare('SELECT tenant FROM token WHERE kode=?')
          .bind(String(kode).toUpperCase()).first();
        return r ? (r.tenant || '') : '';
      } catch (e) {
        return '';
      }
    }

    async function authCtx() {
      const auth = req.headers.get('Authorization') || '';
      const tok = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (!tok) return { admin: false, tenant: null, user: null, active: false, owner: false };
      if (env.ADMIN_KEY && tok === env.ADMIN_KEY) {
        return { admin: true, tenant: null, user: null, active: true, owner: true };
      }
      try {
        const r = await env.DB.prepare(
          "SELECT id,role,tenant,nama,kelas " +
          "FROM users WHERE token=?"
        ).bind(tok).first();
        if (r) return { admin: r.role === 'guru', tenant: r.tenant, user: r, active: true, owner: false };
      } catch (e) {}
      return { admin: false, tenant: null, user: null, active: false, owner: false };
    }


    // ---------- Hasil permainan ----------
    if (u.pathname === '/api/log' && req.method === 'POST') {
      let d; try { d = await req.json(); } catch { return J({ e: 'json' }, 400); }
      const nama = cut(d.nama, 30).trim();
      if (!nama) return J({ e: 'nama' }, 400);

      const ctx = await authCtx();
      let tenant = ctx.tenant != null ? ctx.tenant : '';
      if (!tenant) {
        // Token siswa tetap dikenali walau sesi melewati tengah malam.
        // Tenant mentah dari klien tidak dipercaya agar rekap guru lain tidak bisa disisipi.
        const kode = cut(d.token, 40).trim();
        if (kode) tenant = await tokenTenant(kode, true);
      }

      try {
        const r = await env.DB.prepare(
          'INSERT INTO sesi(tenant,nama,kelas,mode,tim,level,makanan,skor) VALUES(?,?,?,?,?,?,?,?)'
        ).bind(
          tenant, nama, cut(d.kelas, 12), d.mode === 'tim' ? 'tim' : 'solo',
          cut(d.tim, 80), +d.level || 0, cut(d.makanan, 20), +d.skor || 0
        ).run();
        const id = r.meta.last_row_id;
        const st = (Array.isArray(d.jawaban) ? d.jawaban : []).slice(0, 12).map(j =>
          env.DB.prepare('INSERT INTO jawaban(sesi_id,organ,pemain,salah,petunjuk,poin,soal) VALUES(?,?,?,?,?,?,?)')
            .bind(id, cut(j.o, 20), cut(j.p, 30), +j.s || 0, +j.h || 0, +j.pt || 0, cut(j.q, 160))
        );
        if (st.length) await env.DB.batch(st);
        return J({ ok: 1 });
      } catch (e) {
        return J({ e: 'db' }, 500);
      }
    }

    // ---------- Papan skor publik (per guru & per kelas) ----------
    if (u.pathname === '/api/papan' && req.method === 'GET') {
      if (env.PAPAN_PUBLIK === '0') return J({ top: [] });
      try {
        let tenant = u.searchParams.get('tenant') || '';
        const kode = u.searchParams.get('token') || '';
        const kelas = cut(u.searchParams.get('kelas') || '', 12).trim();
        if (kode) {
          tenant = await tokenTenant(kode);
          if (!tenant) return J({ top: [] });
        } else if (tenant && !/^g\d+$/.test(tenant)) {
          const t = await tokenTenant(tenant);
          if (t) tenant = t;
        }
        let sql = 'SELECT nama,kelas,MAX(skor) maks,COUNT(*) sesi FROM sesi';
        const conds = [];
        const binds = [];
        if (tenant) { conds.push('tenant=?'); binds.push(tenant); }
        if (kelas) { conds.push("IFNULL(kelas,'')=?"); binds.push(kelas); }
        if (conds.length) sql += ' WHERE ' + conds.join(' AND ');
        sql += ' GROUP BY nama,kelas ORDER BY maks DESC, sesi DESC LIMIT 10';
        const st = env.DB.prepare(sql);
        const r = binds.length ? await st.bind(...binds).all() : await st.all();
        return J({ top: r.results || [] });
      } catch (e) {
        return J({ top: [] });
      }
    }

    // ---------- Rekap guru (+ CRUD data hasil siswa) ----------
    if (u.pathname === '/api/rekap') {
      const ctx = await authCtx();
      if (!ctx.admin) return J({ e: 'unauthorized' }, 401);
      const t = ctx.tenant;

      if (req.method === 'POST') {
        let d; try { d = await req.json(); } catch { return J({ e: 'json' }, 400); }
        const nama = cut(d.nama, 30).trim();
        if (!nama) return J({ e: 'nama' }, 400);
        const kelas = cut(d.kelas, 12).trim();
        const skor = Math.max(0, Math.min(9999, +d.skor || 0));
        const level = Math.max(0, Math.min(2, +d.level || 1));
        const makanan = cut(d.makanan || 'Manual', 20).trim();
        try {
          const r = await env.DB.prepare(
            "INSERT INTO sesi(tenant,nama,kelas,mode,tim,level,makanan,skor) VALUES(?,?,?,'solo','',?,?,?)"
          ).bind(t || '', nama, kelas, level, makanan, skor).run();
          return J({ ok: 1, id: r.meta.last_row_id });
        } catch (e) {
          return J({ e: 'db' }, 500);
        }
      }

      if (req.method === 'PUT') {
        let d; try { d = await req.json(); } catch { return J({ e: 'json' }, 400); }
        const oldNama = cut(d.old_nama, 30).trim();
        const oldKelas = cut(d.old_kelas, 12).trim();
        const nama = cut(d.nama, 30).trim();
        const kelas = cut(d.kelas, 12).trim();
        if (!oldNama || !nama) return J({ e: 'nama' }, 400);
        try {
          if (t) {
            await env.DB.prepare("UPDATE sesi SET nama=?, kelas=? WHERE tenant=? AND nama=? AND IFNULL(kelas,'')=?")
              .bind(nama, kelas, t, oldNama, oldKelas).run();
            await env.DB.prepare("UPDATE murid SET nama=?, kelas=? WHERE tenant=? AND nama=? AND IFNULL(kelas,'')=?")
              .bind(nama, kelas, t, oldNama, oldKelas).run();
          } else {
            await env.DB.prepare("UPDATE sesi SET nama=?, kelas=? WHERE nama=? AND IFNULL(kelas,'')=?")
              .bind(nama, kelas, oldNama, oldKelas).run();
          }
          if (d.skor !== undefined && d.skor !== null && d.skor !== '') {
            const skorBaru = Math.max(0, Math.min(9999, +d.skor || 0));
            const sRow = t
              ? await env.DB.prepare("SELECT id FROM sesi WHERE tenant=? AND nama=? AND IFNULL(kelas,'')=? ORDER BY skor DESC, id DESC LIMIT 1")
                  .bind(t, nama, kelas).first()
              : await env.DB.prepare("SELECT id FROM sesi WHERE nama=? AND IFNULL(kelas,'')=? ORDER BY skor DESC, id DESC LIMIT 1")
                  .bind(nama, kelas).first();
            if (sRow?.id) {
              await env.DB.prepare('UPDATE sesi SET skor=? WHERE id=?').bind(skorBaru, sRow.id).run();
            }
          }
          return J({ ok: 1 });
        } catch (e) {
          return J({ e: 'db' }, 500);
        }
      }

      if (req.method === 'DELETE') {
        const nama = cut(u.searchParams.get('nama') || '', 30).trim();
        const kelas = cut(u.searchParams.get('kelas') || '', 12).trim();
        if (!nama) return J({ e: 'nama' }, 400);
        try {
          if (t) {
            await env.DB.prepare(
              "DELETE FROM jawaban WHERE sesi_id IN (SELECT id FROM sesi WHERE tenant=? AND nama=? AND IFNULL(kelas,'')=?)"
            ).bind(t, nama, kelas).run();
            await env.DB.prepare(
              "DELETE FROM sesi WHERE tenant=? AND nama=? AND IFNULL(kelas,'')=?"
            ).bind(t, nama, kelas).run();
          } else {
            await env.DB.prepare(
              "DELETE FROM jawaban WHERE sesi_id IN (SELECT id FROM sesi WHERE nama=? AND IFNULL(kelas,'')=?)"
            ).bind(nama, kelas).run();
            await env.DB.prepare(
              "DELETE FROM sesi WHERE nama=? AND IFNULL(kelas,'')=?"
            ).bind(nama, kelas).run();
          }
          return J({ ok: 1 });
        } catch (e) {
          return J({ e: 'db' }, 500);
        }
      }

      const whereSesi = t ? ' WHERE tenant=?' : '';
      const whereJaw = t ? ' WHERE sesi_id IN (SELECT id FROM sesi WHERE tenant=?)' : '';
      const ambil = async (sql) => {
        const st = env.DB.prepare(sql);
        const r = t ? await st.bind(t).all() : await st.all();
        return r.results || [];
      };
      try {
        return J({
          ringkasan: await ambil(
            "SELECT COUNT(*) sesi,COUNT(DISTINCT nama||'|'||IFNULL(kelas,'')) siswa," +
            "IFNULL(ROUND(AVG(skor)),0) rata,IFNULL(MAX(waktu),'-') terakhir FROM sesi" + whereSesi
          ),
          organ: await ambil(
            'SELECT organ,COUNT(*) n,ROUND(AVG(salah),2) rata_salah,' +
            'ROUND(100.0*SUM(poin=0)/COUNT(*)) pct_gagal,ROUND(100.0*AVG(petunjuk)) pct_petunjuk ' +
            'FROM jawaban' + whereJaw + ' GROUP BY organ'
          ),
          siswa: await ambil(
            'SELECT nama,kelas,COUNT(*) sesi,ROUND(AVG(skor)) rata,MAX(skor) maks,MAX(waktu) terakhir ' +
            'FROM sesi' + whereSesi + ' GROUP BY nama,kelas ORDER BY rata ASC'
          ),
          soal: await ambil(
            'SELECT soal,COUNT(*) n,ROUND(AVG(salah),2) rata_salah FROM jawaban' + whereJaw +
            ' GROUP BY soal HAVING n>=3 ORDER BY rata_salah DESC LIMIT 5'
          )
        });
      } catch (e) {
        return J({ e: 'db' }, 500);
      }
    }

    // ---------- Soal ----------
    if (u.pathname === '/api/soal') {
      const ctx = await authCtx();

      if (req.method === 'GET') {
        try {
          let tenant = '';
          if (ctx.admin && ctx.tenant != null) {
            tenant = ctx.tenant; // guru hanya melihat soal miliknya
          } else {
            // Siswa hanya boleh memakai token, bukan kode tenant mentah.
            const kode = u.searchParams.get('token') || '';
            if (!kode) return J({ list: [] });
            tenant = await tokenTenant(kode);
            if (!tenant) return J({ list: [] });
          }
          // Guru melihat soal miliknya saja. Siswa melihat soal bawaan + soal gurunya.
          const sql = ctx.admin && tenant
            ? 'SELECT id,organ,level,pertanyaan,opsi,jawaban,pembahasan FROM soal WHERE tenant=? ORDER BY id DESC'
            : tenant
              ? "SELECT id,organ,level,pertanyaan,opsi,jawaban,pembahasan FROM soal WHERE tenant IN ('',?) ORDER BY id DESC"
              : "SELECT id,organ,level,pertanyaan,opsi,jawaban,pembahasan FROM soal WHERE tenant='' ORDER BY id DESC";
          const r = tenant ? await env.DB.prepare(sql).bind(tenant).all() : await env.DB.prepare(sql).all();
          return J({ list: r.results || [] });
        } catch (e) {
          return J({ list: [] });
        }
      }

      if (req.method === 'POST') {
        if (!ctx.admin) return J({ e: 'unauthorized' }, 401);
        let d; try { d = await req.json(); } catch { return J({ e: 'json' }, 400); }
        const organ = cut(d.organ, 20).trim();
        const pertanyaan = cut(d.pertanyaan, 300).trim();
        if (!organ || !pertanyaan) return J({ e: 'data' }, 400);
        let opsi = d.opsi;
        if (Array.isArray(opsi)) opsi = JSON.stringify(opsi.map(x => cut(x, 80)).filter(Boolean).slice(0, 6));
        else opsi = cut(opsi, 500);
        const tenant = ctx.tenant != null ? ctx.tenant : cut(d.tenant, 40).trim();
        try {
          const r = await env.DB.prepare(
            'INSERT INTO soal(tenant,organ,level,pertanyaan,opsi,jawaban,pembahasan) VALUES(?,?,?,?,?,?,?)'
          ).bind(tenant, organ, +d.level || 1, pertanyaan, opsi, +d.jawaban || 0, cut(d.pembahasan, 300)).run();
          return J({ ok: 1, id: r.meta.last_row_id });
        } catch (e) {
          return J({ e: 'db' }, 500);
        }
      }

      if (req.method === 'DELETE') {
        if (!ctx.admin) return J({ e: 'unauthorized' }, 401);
        const id = +u.searchParams.get('id');
        if (!id) return J({ e: 'id' }, 400);
        try {
          if (ctx.owner) await env.DB.prepare('DELETE FROM soal WHERE id=?').bind(id).run();
          else await env.DB.prepare('DELETE FROM soal WHERE id=? AND tenant=?').bind(id, ctx.tenant).run();
          return J({ ok: 1 });
        } catch (e) {
          return J({ e: 'db' }, 500);
        }
      }
    }

    // ---------- Murid ----------
    if (u.pathname === '/api/murid') {
      const ctx = await authCtx();
      if (!ctx.admin) return J({ e: 'unauthorized' }, 401);
      const tenant = ctx.tenant != null ? ctx.tenant : '';

      if (req.method === 'GET') {
        try {
          const sql = tenant
            ? 'SELECT id,nama,kelas FROM murid WHERE tenant=? ORDER BY nama'
            : 'SELECT id,nama,kelas FROM murid ORDER BY nama';
          const r = tenant ? await env.DB.prepare(sql).bind(tenant).all() : await env.DB.prepare(sql).all();
          return J({ list: r.results || [] });
        } catch (e) {
          return J({ list: [] });
        }
      }

      if (req.method === 'POST') {
        let d; try { d = await req.json(); } catch { return J({ e: 'json' }, 400); }
        try {
          const c = await (tenant
            ? env.DB.prepare('SELECT COUNT(*) n FROM murid WHERE tenant=?').bind(tenant)
            : env.DB.prepare('SELECT COUNT(*) n FROM murid')).first();
          const cur = c?.n || 0;
          if (cur >= 50) return J({ e: 'max50' }, 403);

          if (Array.isArray(d.list)) {
            const sisa = 50 - cur;
            const defKelas = cut(d.kelas, 12).trim();
            const defPin = cut(d.pin, 8).trim();
            const items = d.list.map(x => {
              if (typeof x === 'string') return { nama: cut(x, 30).trim(), kelas: defKelas, pin: defPin };
              return {
                nama: cut(x?.nama, 30).trim(),
                kelas: cut(x?.kelas || defKelas, 12).trim(),
                pin: cut(x?.pin || defPin, 8).trim()
              };
            }).filter(x => x.nama).slice(0, sisa);
            if (!items.length) return J({ e: 'nama' }, 400);
            const st = items.map(x =>
              env.DB.prepare('INSERT INTO murid(tenant,nama,kelas,pin) VALUES(?,?,?,?)')
                .bind(tenant, x.nama, x.kelas, x.pin)
            );
            await env.DB.batch(st);
            return J({ ok: 1, added: items.length });
          }

          const nama = cut(d.nama, 30).trim();
          if (!nama) return J({ e: 'nama' }, 400);
          const r = await env.DB.prepare('INSERT INTO murid(tenant,nama,kelas,pin) VALUES(?,?,?,?)')
            .bind(tenant, nama, cut(d.kelas, 12), cut(d.pin, 8)).run();
          return J({ ok: 1, id: r.meta.last_row_id });
        } catch (e) {
          return J({ e: 'db' }, 500);
        }
      }

      if (req.method === 'PUT') {
        let d; try { d = await req.json(); } catch { return J({ e: 'json' }, 400); }
        const id = +d.id;
        const nama = cut(d.nama, 30).trim();
        const kelas = cut(d.kelas, 12).trim();
        if (!id || !nama) return J({ e: 'data' }, 400);
        try {
          const lama = tenant
            ? await env.DB.prepare('SELECT id,nama,kelas,pin FROM murid WHERE id=? AND tenant=?').bind(id, tenant).first()
            : await env.DB.prepare('SELECT id,nama,kelas,pin FROM murid WHERE id=?').bind(id).first();
          if (!lama) return J({ e: 'siswa' }, 404);
          const pinBaru = d.pin !== undefined ? cut(d.pin, 8).trim() : (lama.pin || '');
          if (tenant) {
            await env.DB.prepare('UPDATE murid SET nama=?, kelas=?, pin=? WHERE id=? AND tenant=?')
              .bind(nama, kelas, pinBaru, id, tenant).run();
            await env.DB.prepare("UPDATE sesi SET nama=?, kelas=? WHERE tenant=? AND nama=? AND IFNULL(kelas,'')=?")
              .bind(nama, kelas, tenant, lama.nama, lama.kelas || '').run();
          } else {
            await env.DB.prepare('UPDATE murid SET nama=?, kelas=?, pin=? WHERE id=?')
              .bind(nama, kelas, pinBaru, id).run();
          }
          return J({ ok: 1 });
        } catch (e) {
          return J({ e: 'db' }, 500);
        }
      }

      if (req.method === 'DELETE') {
        const id = +u.searchParams.get('id');
        if (!id) return J({ e: 'id' }, 400);
        try {
          if (ctx.owner) await env.DB.prepare('DELETE FROM murid WHERE id=?').bind(id).run();
          else await env.DB.prepare('DELETE FROM murid WHERE id=? AND tenant=?').bind(id, ctx.tenant).run();
          return J({ ok: 1 });
        } catch (e) {
          return J({ e: 'db' }, 500);
        }
      }
    }

    // ---------- Akun guru ----------
    if (u.pathname === '/api/auth/register' && req.method === 'POST') {
      let d; try { d = await req.json(); } catch { return J({ e: 'json' }, 400); }
      if (d.role && d.role !== 'guru') return J({ e: 'role' }, 400);
      const nama = cut(d.nama, 30).trim();
      const pin = cut(d.pin, 16);
      if (!nama) return J({ e: 'nama' }, 400);
      if (pin.length < 4) return J({ e: 'pin' }, 400);

      try {
        const cek = await env.DB.prepare("SELECT id FROM users WHERE role='guru' AND lower(nama)=lower(?)").bind(nama).first();
        if (cek) return J({ e: 'nama_dipakai' }, 409);

        const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
        const hash = await sha256(pin);
        const r = await env.DB.prepare(
          "INSERT INTO users(role,tenant,nama,pin_hash,token) VALUES('guru','',?,?,?)"
        ).bind(nama, hash, token).run();
        const id = r.meta.last_row_id;
        const tenant = 'g' + id;
        await env.DB.prepare('UPDATE users SET tenant=? WHERE id=?').bind(tenant, id).run();
        return J({ ok: 1, token, user: { id, role: 'guru', tenant, nama } });
      } catch (e) {
        return J({ e: 'db' }, 500);
      }
    }

    if (u.pathname === '/api/auth/login' && req.method === 'POST') {
      let d; try { d = await req.json(); } catch { return J({ e: 'json' }, 400); }
      const nama = cut(d.nama, 30).trim();
      const pin = cut(d.pin, 16);
      if (!nama || !pin) return J({ e: 'data' }, 400);
      try {
        const hash = await sha256(pin);
        const r = await env.DB.prepare(
          "SELECT id,role,tenant,nama,kelas " +
          "FROM users WHERE role='guru' AND lower(nama)=lower(?) AND pin_hash=?"
        ).bind(nama, hash).first();
        if (!r) return J({ e: 'login' }, 401);
        const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
        await env.DB.prepare('UPDATE users SET token=? WHERE id=?').bind(token, r.id).run();
        return J({
          ok: 1,
          user: {
            id: r.id, role: r.role, tenant: r.tenant, nama: r.nama, kelas: r.kelas, token
          }
        });
      } catch (e) {
        return J({ e: 'db' }, 500);
      }
    }

    if (u.pathname === '/api/auth/me' && req.method === 'GET') {
      const ctx = await authCtx();
      if (!ctx.user) return J({ e: 'unauthorized' }, 401);
      return J({
        ok: 1,
        user: {
          id: ctx.user.id, role: ctx.user.role, tenant: ctx.user.tenant, nama: ctx.user.nama,
          kelas: ctx.user.kelas
        }
      });
    }

    // ---------- Token akses siswa ----------
    if (u.pathname === '/api/token/validate' && req.method === 'POST') {
      let d; try { d = await req.json(); } catch { return J({ e: 'json' }, 400); }
      const kode = cut(d.kode, 40).trim().toUpperCase();
      if (!kode) return J({ e: 'data' }, 400);
      try {
        const r = await env.DB.prepare(
          'SELECT tenant FROM token WHERE kode=?'
        ).bind(kode).first();
        if (!r) return J({ e: 'token' }, 404);
        return J({ ok: 1, tenant: r.tenant });
      } catch (e) {
        return J({ e: 'db' }, 500);
      }
    }

    if (u.pathname === '/api/token/create' && req.method === 'POST') {
      const ctx = await authCtx();
      if (!ctx.admin) return J({ e: 'unauthorized' }, 401);
      const tenant = ctx.tenant != null ? ctx.tenant : '';
      try {
        const lama = await env.DB.prepare(
          'SELECT kode FROM token WHERE tenant=? ORDER BY id DESC LIMIT 1'
        ).bind(tenant).first();
        if (lama) return J({ ok: 1, kode: lama.kode, lama: 1 });

        let kode = '';
        for (let i = 0; i < 6; i++) {
          const c = kodeAcak(6);
          const cek = await env.DB.prepare('SELECT id FROM token WHERE kode=?').bind(c).first();
          if (!cek) { kode = c; break; }
        }
        if (!kode) return J({ e: 'db' }, 500);
        await env.DB.prepare(
          'INSERT INTO token(tenant,kode) VALUES(?,?)'
        ).bind(tenant, kode).run();
        return J({ ok: 1, kode });
      } catch (e) {
        return J({ e: 'db' }, 500);
      }
    }

    if (u.pathname === '/api/token/list' && req.method === 'GET') {
      const ctx = await authCtx();
      if (!ctx.admin) return J({ e: 'unauthorized' }, 401);
      const tenant = ctx.tenant != null ? ctx.tenant : '';
      try {
        const r = await env.DB.prepare(
          'SELECT kode FROM token WHERE tenant=? ORDER BY id DESC'
        ).bind(tenant).all();
        return J({ list: r.results || [] });
      } catch (e) {
        return J({ list: [] });
      }
    }

    // ---------- Siswa ----------
    if (u.pathname === '/api/siswa' && req.method === 'GET') {
      try {
        const kode = u.searchParams.get('token') || '';
        const tenant = await tokenTenant(kode);
        if (!tenant) return J({ list: [] });
        const r = await env.DB.prepare('SELECT id,nama,kelas FROM murid WHERE tenant=? ORDER BY nama').bind(tenant).all();
        return J({ list: r.results || [] });
      } catch (e) {
        return J({ list: [] });
      }
    }

    if (u.pathname === '/api/siswa/login' && req.method === 'POST') {
      let d; try { d = await req.json(); } catch { return J({ e: 'json' }, 400); }
      const kode = cut(d.token, 40).trim().toUpperCase();
      const id = +d.id;
      const pin = cut(d.pin, 8);
      if (!kode || !id) return J({ e: 'data' }, 400);
      try {
        const tenant = await tokenTenant(kode);
        if (!tenant) return J({ e: 'token' }, 404);
        const r = await env.DB.prepare('SELECT id,nama,kelas,pin FROM murid WHERE id=? AND tenant=?').bind(id, tenant).first();
        if (!r) return J({ e: 'siswa' }, 404);
        if (r.pin && String(r.pin) !== pin) return J({ e: 'pin' }, 401);
        return J({ ok: 1, siswa: { id: r.id, nama: r.nama, kelas: r.kelas, tenant } });
      } catch (e) {
        return J({ e: 'db' }, 500);
      }
    }

    if (u.pathname === '/api/siswa/register' && req.method === 'POST') {
      let d; try { d = await req.json(); } catch { return J({ e: 'json' }, 400); }
      const kode = cut(d.token, 40).trim().toUpperCase();
      const nama = cut(d.nama, 30).trim();
      const kelas = cut(d.kelas, 12).trim();
      const pin = cut(d.pin, 8).trim();
      if (!kode || !nama) return J({ e: 'data' }, 400);
      try {
        const tenant = await tokenTenant(kode);
        if (!tenant) return J({ e: 'token' }, 404);
        const ada = await env.DB.prepare('SELECT id,nama,kelas,pin FROM murid WHERE tenant=? AND lower(nama)=lower(?)').bind(tenant, nama).first();
        if (ada) {
          if (ada.pin && String(ada.pin) !== pin) return J({ e: 'pin' }, 401);
          return J({ ok: 1, siswa: { id: ada.id, nama: ada.nama, kelas: ada.kelas, tenant } });
        }
        const c = await env.DB.prepare('SELECT COUNT(*) n FROM murid WHERE tenant=?').bind(tenant).first();
        if ((c?.n || 0) >= 50) return J({ e: 'max50' }, 403);
        const r = await env.DB.prepare('INSERT INTO murid(tenant,nama,kelas,pin) VALUES(?,?,?,?)')
          .bind(tenant, nama, kelas, pin).run();
        return J({ ok: 1, siswa: { id: r.meta.last_row_id, nama, kelas, tenant } });
      } catch (e) {
        return J({ e: 'db' }, 500);
      }
    }


    if (u.pathname === '/admin') {
      return new Response(null, {
        status: 302,
        headers: { Location: ADMIN_URL, 'Cache-Control': 'no-store' }
      });
    }

    return J({ ok: 1, info: 'API Petualangan Makanan' });
  }
};

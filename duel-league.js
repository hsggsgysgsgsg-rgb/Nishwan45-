// duel-league.js — سكربت دوري 1v1 (24 ساعة): تعيين الخصوم + حساب النقاط والأكلات + مكافأة 250
// يشتغل على GitHub Actions كل 10 دقايق (شوف .github/workflows/duel-league.yml)
const admin = require("firebase-admin");

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  databaseURL: "https://nishwan45-70b05-default-rtdb.firebaseio.com",
});
const db = admin.database();
const INC = admin.database.ServerValue.increment;

const DAY = 24 * 3600 * 1000;
const WIN_PTS = 25, DRAW_PTS = 13, TOP_BONUS = 250;

async function main() {
  const now = Date.now();
  const cycle = (await db.ref("duelCycle").once("value")).val();
  if (!cycle || !cycle.start) { console.log("لا توجد duelCycle.start — لا شيء للتنفيذ"); return; }
  const start = cycle.start;
  const end = start + DAY;
  if (now < start) { console.log("الدورة لم تبدأ بعد"); return; }

  // 1) تعيين الخصوم مرة وحدة لكل دورة
  if (cycle.assignedFor !== start && now <= end) await assignOpponents(start);

  // 2) حساب المباريات المنتهية داخل نافذة الدورة
  await processRooms(start, end);

  // 3) مكافأة الفائز بعد نهاية الدورة (مرة وحدة)
  if (now > end + 10 * 60 * 1000 && cycle.rewardedFor !== start) await payBonus(start);
}

async function assignOpponents(start) {
  const snap = await db.ref("players").once("value");
  const players = snap.val() || {};
  const ids = Object.keys(players).filter((id) => players[id] && players[id].name);
  for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [ids[i], ids[j]] = [ids[j], ids[i]]; }
  const updates = {};
  for (const id of ids) { // تصفير نقاط الدورة للجميع
    updates[`players/${id}/duelSeasonPoints`] = 0;
    updates[`players/${id}/duelSeasonCaptures`] = 0;
    updates[`players/${id}/duelOpp`] = null;
  }
  for (let i = 0; i + 1 < ids.length; i += 2) {
    const a = ids[i], b = ids[i + 1];
    updates[`players/${a}/duelOpp`] = { id: b, name: players[b].name || "لاعب", photo: players[b].photo || "" };
    updates[`players/${b}/duelOpp`] = { id: a, name: players[a].name || "لاعب", photo: players[a].photo || "" };
  }
  await db.ref().update(updates);
  await db.ref("duelCycle/assignedFor").set(start);
  console.log("تم تعيين الخصوم لـ", Math.floor(ids.length / 2) * 2, "لاعب");
}

async function processRooms(start, end) {
  const snap = await db.ref("rooms").orderByChild("created").startAt(start).endAt(end).once("value");
  const rooms = snap.val() || {};
  for (const [roomId, r] of Object.entries(rooms)) {
    if (!r || !r.winner || roomId.startsWith("friend_")) continue;
    const w = r.whiteUid || (r.white && r.white.uid);
    const b = r.blackUid || (r.black && r.black.uid);
    if (!w || !b || w === b) continue;

    const [wp, bp] = await Promise.all([
      db.ref(`players/${w}/duelOpp/id`).once("value"),
      db.ref(`players/${b}/duelOpp/id`).once("value"),
    ]);
    if (wp.val() !== b || bp.val() !== w) continue; // مو خصمين محددين لبعض

    // منع الحساب المزدوج
    const lock = await db.ref(`duelProcessed/${roomId}`).transaction((cur) => (cur ? undefined : Date.now()));
    if (!lock.committed) continue;

    const winner = String(r.winner);            // white | black | draw | draw_repetition | white_resign | black_timeout ...
    const isDraw = winner.startsWith("draw");
    const winColor = winner.split("_")[0];
    const capW = r.whiteCaptures || 0, capB = r.blackCaptures || 0;  // الأكلات تنحسب حتى لو الخصم انسحب
    const ts = r.created || Date.now();

    const sides = [[w, "white", capW], [b, "black", capB]];
    const updates = {};
    for (const [uid, color, caps] of sides) {
      const result = isDraw ? "draw" : (color === winColor ? "win" : "loss");
      const pts = result === "win" ? WIN_PTS : result === "draw" ? DRAW_PTS : 0;
      updates[`duelMatches/${uid}/${roomId}`] = { result, pieces: caps, ts };
      updates[`players/${uid}/duelSeasonPoints`] = INC(pts);
      updates[`players/${uid}/duelSeasonCaptures`] = INC(caps);
    }
    await db.ref().update(updates);
    console.log("حُسبت مباراة", roomId, winner, `أكلات ${capW}/${capB}`);
  }
}

async function payBonus(start) {
  const snap = await db.ref("players").once("value");
  const players = snap.val() || {};
  const done = new Set();
  const updates = {};
  for (const [id, p] of Object.entries(players)) {
    const oppId = p && p.duelOpp && p.duelOpp.id;
    if (!oppId || done.has(id) || !players[oppId]) continue;
    done.add(id); done.add(oppId);
    const o = players[oppId];
    const sa = p.duelSeasonPoints || 0, sb = o.duelSeasonPoints || 0;
    const ca = p.duelSeasonCaptures || 0, cb = o.duelSeasonCaptures || 0;
    let top = null;
    if (sa !== sb) top = sa > sb ? id : oppId;          // الأعلى نقاط
    else if (ca !== cb && (sa > 0)) top = ca > cb ? id : oppId; // تعادل بالنقاط → الأكثر أكلات
    if (!top || (Math.max(sa, sb) === 0)) continue;     // ما لعبوا = بدون مكافأة
    const tp = players[top];
    const newPts = (tp.points || 0) + TOP_BONUS;
    updates[`players/${top}/points`] = newPts;
    updates[`players/${top}/maxPoints`] = Math.max(tp.maxPoints || 0, newPts);
  }
  await db.ref().update(updates);
  await db.ref("duelCycle/rewardedFor").set(start);
  console.log("تم توزيع مكافآت الدورة:", Object.keys(updates).length / 2, "فائز");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

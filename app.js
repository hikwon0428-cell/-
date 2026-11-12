/* 혜인·진우 가계부 — Firebase(구글 로그인 + Firestore) 위에서 돌아가는 정적 사이트 */
(function () {
"use strict";
const { CATS, Model } = window.Categorizer;
const CAT = Object.fromEntries(CATS.map((c) => [c.id, c]));
const COL = { months: "ledgerMonths", expenses: "ledgerExpenses", fixed: "ledgerFixed" };

const S = { months: {}, expenses: [], fixed: [], cur: null, view: "month", me: "혜인",
  editExp: null, editFixed: null, catFilter: null, armed: null, loaded: { m: 0, e: 0, f: 0 },
  draft: { name: "", amt: "", who: null, cat: null, catTouched: false }, user: null };
const model = new Model();
let fs = null, auth = null, unsubs = [], pendingRender = false, modelDirty = true;
try { S.me = localStorage.getItem("me") || "혜인"; } catch (e) {}

/* ---------- helpers ---------- */
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const won = (n) => n == null || isNaN(n) ? "–" : (n < 0 ? "−" : "") + Math.abs(Math.round(n)).toLocaleString("ko-KR");
const parse = (s) => { s = String(s ?? "").trim(); if (!s) return null; const neg = /^[−-]|^₩\s*[−-]/.test(s); const d = s.replace(/[^\d]/g, ""); return d ? (neg ? -1 : 1) * Number(d) : null; };
const sum = (a) => a.reduce((t, x) => t + (Number(x) || 0), 0);
const keyLabel = (k) => { const [y, m] = k.split("-"); return `${y.slice(2)}년 ${+m}월`; };
const shiftKey = (k, d) => { let [y, m] = k.split("-").map(Number); m += d; while (m > 12) { m -= 12; y++; } while (m < 1) { m += 12; y--; } return `${y}-${String(m).padStart(2, "0")}`; };
const periodOf = (k) => { const p = shiftKey(k, -1); return `${+p.split("-")[1]}/26 – ${+k.split("-")[1]}/25`; };
const monthKeys = () => Object.keys(S.months).sort();
const catSty = (id) => `color:var(${(CAT[id] || CAT.etc).c})`;
const catBg = (id) => `background:var(${(CAT[id] || CAT.etc).c})`;
const fixedSum = () => sum(S.fixed.map((f) => f.amount));
function currentKey() { const d = new Date(); if (d.getDate() > 25) d.setMonth(d.getMonth() + 1, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; }
function ensureModel() { if (modelDirty) { model.train(S.expenses); modelDirty = false; } }

function setStatus(t, err) { const el = $("#status"); el.textContent = t || ""; el.hidden = !t; el.classList.toggle("err", !!err); }
async function write(fn) {
  try { await fn(); }
  catch (e) {
    setStatus(e && e.code === "permission-denied" ? "이 계정은 저장 권한이 없어요. 등록된 구글 계정으로 로그인했는지 확인해 주세요." : "저장하지 못했어요. 인터넷 연결을 확인하고 다시 시도해 주세요.", true);
  }
}
const ref = (col, id) => fs.collection(COL[col]).doc(id);

/* ---------- AI 추천 ---------- */
function aiSuggest(name) { ensureModel(); return name.trim() ? model.predict(name).slice(0, 3) : []; }
function aiBar() {
  const d = S.draft; const sug = aiSuggest(d.name);
  if (!sug.length) return `<span class="tag">AI 분류</span><span>내용을 쓰면 우리 기록을 보고 분류를 골라줘요</span>`;
  const chosen = d.catTouched ? d.cat : sug[0].id;
  const top = sug.filter((s, i) => i === 0 || s.p >= 0.08);
  const ids = new Set(top.map((s) => s.id));
  return `<span class="tag">AI 분류</span>${top.map((s) => `<button type="button" data-act="pickcat" data-cat="${s.id}" aria-pressed="${chosen === s.id}">${CAT[s.id].name} <span class="num">${Math.round(s.p * 100)}%</span></button>`).join("")}
    <select data-act-change="pickcat" aria-label="다른 분류 고르기" style="font-size:12px;padding:3px 6px">
      <option value="">다른 분류…</option>${CATS.filter((c) => !ids.has(c.id)).map((c) => `<option value="${c.id}" ${chosen === c.id ? "selected" : ""}>${c.name}</option>`).join("")}</select>`;
}
function refreshAi() { const el = $("#aibar"); if (el) el.innerHTML = aiBar(); }

/* ---------- views ---------- */
function monthView() {
  const keys = monthKeys();
  if (!keys.length && !S.loaded.m) return `<div class="panel empty">장부를 불러오는 중…</div>`;
  if (!keys.length) return `<div class="panel empty">아직 기록된 달이 없어요.<br><br>
    <button class="primary" data-act="newmonth">${keyLabel(currentKey())} 장부 만들기</button><br><br>
    <span class="small">예전 기록이 담긴 가져오기 파일이 있다면 <label style="text-decoration:underline;cursor:pointer">여기서 올려 주세요<input type="file" id="importfile" hidden></label>.</span></div>`;
  const k = S.cur, m = S.months[k] || {}; const incomes = m.incomes || [];
  const ex = S.expenses.filter((e) => e.month === k).sort((a, b) => (a.ts || 0) - (b.ts || 0));
  const incT = sum(incomes.map((i) => i.amount)), varT = sum(ex.map((e) => e.amount)), fx = Number(m.fixedTotal) || 0, spend = fx + varT;
  const park = m.parking, gap = park == null ? null : incT - spend - park;
  const byCat = {}; ex.forEach((e) => byCat[e.cat || "etc"] = (byCat[e.cat || "etc"] || 0) + (e.amount || 0));
  const catList = CATS.filter((c) => byCat[c.id]).sort((a, b) => byCat[b.id] - byCat[a.id]);
  const posTot = sum(Object.values(byCat).filter((v) => v > 0)) || 1;
  const shown = S.catFilter ? ex.filter((e) => (e.cat || "etc") === S.catFilter) : ex;
  const idx = keys.indexOf(k); const who = S.draft.who || S.me;
  return `
  <div class="monthbar">
    <button class="icon" data-act="prev" ${idx <= 0 ? "disabled" : ""} aria-label="이전 달">‹</button>
    <div><div class="lbl">${keyLabel(k)}</div><div class="period num">${periodOf(k)}</div></div>
    <button class="icon" data-act="next" ${idx >= keys.length - 1 ? "disabled" : ""} aria-label="다음 달">›</button>
    <select id="jump" aria-label="달 고르기">${keys.slice().reverse().map((x) => `<option value="${x}" ${x === k ? "selected" : ""}>${keyLabel(x)}</option>`).join("")}</select>
    <span class="sp"></span>
    ${idx === keys.length - 1 ? `<button data-act="newmonth">＋ ${keyLabel(shiftKey(k, 1))} 시작</button>` : ""}
  </div>
  <div class="summary">
    <div><div class="k">수입 총합</div><div class="v num">${won(incT)}</div><div class="s">이월 포함</div></div>
    <div><div class="k">지출 합계</div><div class="v num">${won(spend)}</div><div class="s num">고정 ${won(fx)} · 유동 ${won(varT)}</div></div>
    <div><div class="k"><label for="park">파킹통장 실제 잔액</label></div><input id="park" class="amt" inputmode="numeric" data-live="park" value="${park == null ? "" : won(park)}" placeholder="25일에 입력"><div class="s">다음 달 이월로 넘어가요</div></div>
    <div><div class="k">차액</div><div class="v num ${gap == null ? "" : Math.abs(gap) <= 100000 ? "gap-ok" : "gap-warn"}">${gap == null ? "–" : won(gap)}</div><div class="s">수입 − 지출 − 파킹통장</div></div>
  </div>
  <div class="grid2">
    <div>
      <section class="panel"><h3>수입</h3>
        <div class="rows">${incomes.map((it, i) => `<div class="row">
          <input aria-label="수입 이름" data-live="inc-name" data-i="${i}" value="${esc(it.name)}">
          <input class="amt" inputmode="numeric" aria-label="${esc(it.name)} 금액" data-live="inc-amt" data-i="${i}" value="${it.amount == null ? "" : won(it.amount)}">
          <button class="ghost" data-act="delinc" data-i="${i}" aria-label="${esc(it.name)} 삭제">✕</button></div>`).join("") || `<div class="empty">수입 항목이 없어요</div>`}</div>
        <div class="total"><span>합계</span><span class="num">${won(incT)}</span></div>
        <form class="addline" data-form="inc"><input name="name" placeholder="예: 11월 월급(혜인)" aria-label="새 수입 이름"><input name="amt" class="amt" inputmode="numeric" placeholder="금액" aria-label="새 수입 금액" style="width:8.5em"><button>추가</button></form>
      </section>
      <section class="panel"><h3>어디에 썼나</h3>
        ${catList.length ? `<div class="cats">${catList.map((c) => `<i style="${catBg(c.id)};width:${Math.max(0, byCat[c.id]) / posTot * 100}%"></i>`).join("")}</div>
        <div class="rows">${catList.map((c) => `<div class="hbar" style="grid-template-columns:minmax(0,1fr) auto"><span><span class="dot" style="${catBg(c.id)}"></span> ${c.name}</span><span class="num">${won(byCat[c.id])}</span></div>`).join("")}</div>` : `<div class="empty">유동비를 기록하면 분류별로 보여줘요</div>`}
      </section>
    </div>
    <section class="panel">
      <div class="fixedline"><span>고정비</span><input class="amt" inputmode="numeric" data-live="fixedTotal" aria-label="이 달 고정비" value="${m.fixedTotal == null ? "" : won(m.fixedTotal)}" style="width:9.5em">
        ${fx !== fixedSum() ? `<button class="ghost" data-act="syncfixed">고정비 탭 합계(${won(fixedSum())})로 맞추기</button>` : `<span class="small muted">고정비 탭과 같아요</span>`}</div>
      <h3>유동비 기록</h3>
      <form class="quick" data-form="exp">
        <input name="name" id="q-name" placeholder="뭐에 썼어요? (예: 주유 11/14)" aria-label="지출 내용" autocomplete="off" value="${esc(S.draft.name)}" required>
        <input name="amt" id="q-amt" class="amt" inputmode="numeric" placeholder="금액" aria-label="지출 금액" value="${esc(S.draft.amt)}" required>
        <select name="who" id="q-who" aria-label="누가">${["공동", "혜인", "진우"].map((w) => `<option ${w === who ? "selected" : ""}>${w}</option>`).join("")}</select>
        <button class="primary">기록</button>
      </form>
      <div class="ai" id="aibar" aria-live="polite">${aiBar()}</div>
      ${catList.length > 1 ? `<div class="legend">${catList.map((c) => `<button type="button" data-act="filter" data-cat="${c.id}" aria-pressed="${S.catFilter === c.id}"><span class="dot" style="${catBg(c.id)}"></span>${c.name}</button>`).join("")}${S.catFilter ? `<button type="button" data-act="filter" data-cat="">전체 보기</button>` : ""}</div>` : ""}
      <div>${shown.length ? shown.map(expRow).join("") : `<div class="empty">${S.catFilter ? "이 분류의 지출이 없어요" : "아직 기록이 없어요. 위에서 첫 지출을 적어보세요."}</div>`}</div>
      <div class="total"><span>유동비 ${S.catFilter ? `(${CAT[S.catFilter].name})` : "합계"}</span><span class="num">${won(sum(shown.map((e) => e.amount)))}</span></div>
    </section>
  </div>`;
}
function expRow(e) {
  if (S.editExp === e.id) return `<form class="editbox" data-form="editexp" data-id="${e.id}">
    <input class="nmI" name="name" value="${esc(e.name)}" aria-label="내용">
    <input name="amt" class="amt" inputmode="numeric" value="${won(e.amount)}" aria-label="금액">
    <select name="cat" aria-label="분류">${CATS.map((c) => `<option value="${c.id}" ${c.id === (e.cat || "etc") ? "selected" : ""}>${c.name}</option>`).join("")}</select>
    <select name="who" aria-label="누가">${["공동", "혜인", "진우"].map((w) => `<option ${w === (e.who || "공동") ? "selected" : ""}>${w}</option>`).join("")}</select>
    <div class="full"><input name="memo" value="${esc(e.memo)}" placeholder="메모 (예: 빼야함)" aria-label="메모">
      <button class="primary">저장</button><button type="button" data-act="cancel">취소</button>
      <button type="button" class="danger" data-act="delexp" data-id="${e.id}">${S.armed === e.id ? "정말 삭제" : "삭제"}</button></div>
    <div class="full small muted">분류를 바꾸면 AI가 다음부터 그렇게 배워요.</div></form>`;
  return `<div class="exp" data-act="editexp" data-id="${e.id}" tabindex="0" role="button" aria-label="${esc(e.name)} 수정">
    <span class="chip" style="${catSty(e.cat || "etc")}">${(CAT[e.cat] || CAT.etc).name}</span>
    <span class="nm">${esc(e.name)}${e.memo ? `<span class="memo">${esc(e.memo)}</span>` : ""}</span>
    <span class="who">${esc(e.who || "공동")}</span>
    <span class="num">${won(e.amount)}</span></div>`;
}

function fixedView() {
  const items = S.fixed.slice().sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
  const total = fixedSum();
  const people = ["혜인", "진우", "공동"].filter((p) => items.some((f) => (f.payer || "공동") === p));
  const loans = items.filter((f) => f.kind === "대출");
  const today = new Date();
  return `
  <div class="monthbar"><div><div class="lbl">고정비</div><div class="period">매달 빠져나가는 돈</div></div><span class="sp"></span>
    <div style="text-align:right"><div class="small muted">한 달 총 고정비</div><div class="num" style="font-size:22px;font-weight:700">${won(total)}</div></div></div>
  ${items.length ? "" : `<div class="panel empty">아직 고정비가 없어요. 아래에서 첫 항목을 추가해 주세요.</div>`}
  <div class="persons">${people.map((p) => { const its = items.filter((f) => (f.payer || "공동") === p); return `<section class="panel"><h3>${p} 통장에서</h3>
    <div class="rows">${its.map((f) => S.editFixed === f.id ? fixedEdit(f) : `<div class="exp" data-act="editfixed" data-id="${f.id}" tabindex="0" role="button" aria-label="${esc(f.name)} 수정" style="grid-template-columns:minmax(0,1fr) auto auto">
      <span class="nm">${esc(f.name)}</span><span class="chip" style="color:var(--muted)">${esc(f.kind || "기타")}</span><span class="num">${won(f.amount)}</span></div>`).join("")}</div>
    <div class="total"><span>소계</span><span class="num">${won(sum(its.map((f) => f.amount)))}</span></div></section>`; }).join("")}</div>
  ${S.editFixed === "new" ? `<section class="panel" style="margin-top:20px"><h3>새 고정비</h3>${fixedEdit({})}</section>` : `<p><button data-act="newfixed">＋ 고정비 항목 추가</button></p>`}
  ${loans.length ? `<section class="panel" style="margin-top:20px"><h3>대출·할부 진행</h3>${loans.map((f) => {
    let prog = "", rest = "";
    if (f.start && f.end) { const s = new Date(f.start), e = new Date(f.end); const tot = (e.getFullYear() - s.getFullYear()) * 12 + e.getMonth() - s.getMonth() + 1;
      const left = Math.max(0, (e.getFullYear() - today.getFullYear()) * 12 + e.getMonth() - today.getMonth()); const pct = Math.min(100, Math.max(0, (tot - left) / tot * 100));
      prog = `<div class="bar"><i style="width:${pct}%"></i></div>`; rest = `<span class="num">${f.start} → ${f.end}</span> · 남은 ${left}개월 · 남은 상환액 약 <span class="num">${won(left * f.amount)}</span>`; }
    return `<div class="loan"><div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap"><strong>${esc(f.name)}</strong><span class="num">월 ${won(f.amount)}</span></div>${prog}
      <div class="small muted">${f.principal ? `원금 <span class="num">${won(f.principal)}</span>` : ""}${rest ? " · " + rest : f.principal ? "" : "기간을 넣으면 남은 개월을 계산해요"}</div></div>`; }).join("")}</section>` : ""}
  <p class="note">여기 합계는 '이번 달' 탭의 고정비 칸에 한 번에 반영할 수 있어요.</p>`;
}
function fixedEdit(f) {
  return `<form class="editbox" data-form="fixed" data-id="${f.id || ""}" style="grid-template-columns:minmax(0,1.4fr) 8.5em 6.5em 6.5em">
    <input class="nmI" name="name" value="${esc(f.name)}" placeholder="이름 (예: LG 구독)" aria-label="이름" required>
    <input name="amt" class="amt" inputmode="numeric" value="${f.amount == null ? "" : won(f.amount)}" placeholder="월 금액" aria-label="월 금액" required>
    <select name="payer" aria-label="어느 통장">${["혜인", "진우", "공동"].map((w) => `<option ${w === (f.payer || S.me) ? "selected" : ""}>${w}</option>`).join("")}</select>
    <select name="kind" aria-label="종류">${["대출", "보험", "생활비", "용돈", "저축", "구독", "통신", "기타"].map((w) => `<option ${w === (f.kind || "기타") ? "selected" : ""}>${w}</option>`).join("")}</select>
    <div class="full"><input name="principal" class="amt" inputmode="numeric" value="${f.principal ? won(f.principal) : ""}" placeholder="원금(대출일 때)" aria-label="원금" style="max-width:10em">
      <input name="start" type="date" value="${esc(f.start)}" aria-label="시작일" style="max-width:10.5em"><input name="end" type="date" value="${esc(f.end)}" aria-label="만기일" style="max-width:10.5em"></div>
    <div class="full"><button class="primary">저장</button><button type="button" data-act="cancel">취소</button>
      ${f.id ? `<button type="button" class="danger" data-act="delfixed" data-id="${f.id}">${S.armed === f.id ? "정말 삭제" : "삭제"}</button>` : ""}</div></form>`;
}

function investView() {
  const keys = monthKeys(); if (!keys.length) return `<div class="panel empty">먼저 '이번 달'에서 장부를 만들어 주세요.</div>`;
  const k = S.cur, m = S.months[k] || {}; const inv = m.investments || [];
  const P = sum(inv.map((r) => r.principal)), C = sum(inv.map((r) => r.current)), PL = C - P;
  const prevWith = keys.filter((x) => x < k && (S.months[x].investments || []).length).pop();
  const idx = keys.indexOf(k);
  return `
  <div class="monthbar"><button class="icon" data-act="prev" ${idx <= 0 ? "disabled" : ""} aria-label="이전 달">‹</button>
    <div><div class="lbl">${keyLabel(k)} 투자</div><div class="period">계좌별 원금과 현재 평가액</div></div>
    <button class="icon" data-act="next" ${idx >= keys.length - 1 ? "disabled" : ""} aria-label="다음 달">›</button><span class="sp"></span>
    ${prevWith ? `<button data-act="copyinv" data-from="${prevWith}">${keyLabel(prevWith)} 계좌 불러오기</button>` : ""}</div>
  <div class="summary" style="grid-template-columns:repeat(3,1fr)">
    <div><div class="k">원금</div><div class="v num">${won(P)}</div></div>
    <div><div class="k">현재 평가액</div><div class="v num">${won(C)}</div></div>
    <div><div class="k">손익</div><div class="v num ${PL >= 0 ? "pos" : "neg"}">${PL > 0 ? "+" : ""}${won(PL)}</div><div class="s num">${P ? ((PL / P * 100).toFixed(1) + "%") : ""}</div></div>
  </div>
  <section class="panel"><div class="scroll"><table class="tbl"><thead><tr><th>계좌</th><th class="r">원금</th><th class="r">현재금액</th><th class="r">손익</th><th></th></tr></thead><tbody>
  ${inv.map((r, i) => { const pl = (r.current || 0) - (r.principal || 0); return `<tr>
    <td><input data-live="inv-account" data-i="${i}" value="${esc(r.account)}" aria-label="계좌 이름" style="min-width:8em"></td>
    <td><input class="amt" inputmode="numeric" data-live="inv-principal" data-i="${i}" value="${r.principal == null ? "" : won(r.principal)}" aria-label="원금" style="min-width:8em"></td>
    <td><input class="amt" inputmode="numeric" data-live="inv-current" data-i="${i}" value="${r.current == null ? "" : won(r.current)}" aria-label="현재금액" style="min-width:8em"></td>
    <td class="r num ${pl >= 0 ? "pos" : "neg"}" style="white-space:nowrap">${pl > 0 ? "+" : ""}${won(pl)}<div class="small">${r.principal ? (pl / r.principal * 100).toFixed(1) + "%" : ""}</div></td>
    <td><button class="ghost" data-act="delinv" data-i="${i}" aria-label="${esc(r.account)} 삭제">✕</button></td></tr>`; }).join("") || `<tr><td colspan="5" class="empty">${prevWith ? "위 버튼으로 지난 계좌 목록을 불러오거나, " : ""}계좌를 추가해 주세요</td></tr>`}
  </tbody></table></div>
  <form class="addline" data-form="inv"><input name="name" placeholder="예: 진우(한투 주식)" aria-label="새 계좌 이름"><button>계좌 추가</button></form></section>`;
}

function reviewList() {
  ensureModel();
  const out = [];
  for (const e of S.expenses) {
    if (e.catSource === "user") continue;               // 사람이 정한 건 건드리지 않음
    const p = model.predict(e.name, e)[0];
    if (p && p.id !== (e.cat || "etc") && p.p >= 0.7) out.push({ e, to: p.id, p: p.p });
  }
  return out.sort((a, b) => b.p - a.p).slice(0, 12);
}
function trendView() {
  const keys = monthKeys(); if (!keys.length) return `<div class="panel empty">기록이 쌓이면 여기서 달별 흐름을 보여줘요.</div>`;
  const data = keys.map((k) => { const m = S.months[k]; const v = sum(S.expenses.filter((e) => e.month === k).map((e) => e.amount)); return { k, v, f: Number(m.fixedTotal) || 0, p: m.parking }; });
  const max = Math.max(1, ...data.map((d) => d.v + Math.max(0, d.f)));
  const W = 640, H = 250, L = 46, B = 26, T = 30, bw = (W - L - 8) / data.length;
  const step = niceStep(max); const ticks = []; for (let t = 0; t < max + step; t += step) ticks.push(t); const top = ticks[ticks.length - 1] || max;
  const y = (v) => T + (H - T - B) * (1 - v / top);
  const svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="월별 지출 막대 그래프">
   ${ticks.map((t) => `<line x1="${L}" x2="${W - 4}" y1="${y(t)}" y2="${y(t)}" stroke="var(--line)" stroke-width="1"/><text x="${L - 6}" y="${y(t) + 4}" text-anchor="end">${+(t / 1e6).toFixed(1)}</text>`).join("")}
   ${data.map((d, i) => { const x = L + i * bw + bw * .18, w = bw * .64; const fh = Math.max(0, d.f), yf = y(fh), yv = y(fh + d.v);
     return `<rect x="${x}" y="${yf}" width="${w}" height="${y(0) - yf}" fill="var(--soft)" stroke="var(--line)"/><rect x="${x}" y="${yv}" width="${w}" height="${Math.max(0, yf - yv)}" fill="var(--accent)" rx="2"><title>${keyLabel(d.k)} 유동비 ${won(d.v)} / 고정비 ${won(d.f)}</title></rect>
     <text x="${x + w / 2}" y="${H - 8}" text-anchor="middle" class="lab">${+d.k.slice(5)}월</text>`; }).join("")}
   <text x="${L - 6}" y="12" text-anchor="end">백만원</text></svg>`;
  const byCat = {}; S.expenses.forEach((e) => { const c = e.cat || "etc"; byCat[c] = (byCat[c] || 0) + (e.amount || 0); });
  const cl = CATS.filter((c) => byCat[c.id] > 0).sort((a, b) => byCat[b.id] - byCat[a.id]); const cm = Math.max(1, ...cl.map((c) => byCat[c.id]));
  const pk = data.filter((d) => d.p != null);
  const rv = reviewList();
  return `
  <div class="monthbar"><div><div class="lbl">흐름</div><div class="period">${keyLabel(keys[0])} – ${keyLabel(keys[keys.length - 1])}</div></div></div>
  <section class="panel chart"><h3>달별 지출 <span class="small">(<span class="dot" style="background:var(--accent)"></span> 유동비 · <span class="dot" style="background:var(--soft);border:1px solid var(--line)"></span> 고정비)</span></h3>${svg}</section>
  <div class="grid2" style="margin-top:20px">
    <div>
      <section class="panel"><h3>파킹통장 잔액</h3>${pk.length ? pk.map((d) => `<div class="row" style="grid-template-columns:minmax(0,1fr) auto"><span>${keyLabel(d.k)}</span><span class="num">${won(d.p)}</span></div>`).join("") : `<div class="empty">아직 입력된 잔액이 없어요</div>`}</section>
      <section class="panel"><h3>AI 분류 점검</h3>
        ${rv.length ? `<p class="small muted" style="margin:0 0 6px">우리 기록을 보면 다른 분류가 더 맞아 보이는 항목이에요. 맞으면 바꾸기를 눌러 주세요.</p>${rv.map((r) => `<div class="review"><div><div>${esc(r.e.name)} <span class="small muted">${keyLabel(r.e.month)}</span></div>
          <div class="arrow"><span style="${catSty(r.e.cat || "etc")}">${(CAT[r.e.cat] || CAT.etc).name}</span> → <b style="${catSty(r.to)}">${CAT[r.to].name}</b> <span class="num">${Math.round(r.p * 100)}%</span></div></div>
          <div style="display:flex;gap:4px"><button data-act="reviewyes" data-id="${r.e.id}" data-cat="${r.to}">바꾸기</button><button class="ghost" data-act="reviewno" data-id="${r.e.id}" aria-label="지금 분류 유지">유지</button></div></div>`).join("")}`
          : `<div class="empty">지금은 점검할 항목이 없어요</div>`}
      </section>
    </div>
    <section class="panel"><h3>전체 기간 분류별 유동비</h3>${cl.map((c) => `<div class="hbar"><span><span class="dot" style="${catBg(c.id)}"></span> ${c.name}</span><span class="track"><i style="${catBg(c.id)};width:${byCat[c.id] / cm * 100}%"></i></span><span class="num" style="text-align:right">${won(byCat[c.id])}</span></div>`).join("") || `<div class="empty">기록이 없어요</div>`}</section>
  </div>
  ${importPanel()}`;
}
function importPanel() {
  return `<section class="panel" style="margin-top:20px"><h3>예전 기록 가져오기</h3>
    <p class="small muted" style="margin:0 0 10px">가져오기 파일(.json)을 고르면 그 안의 달·지출·고정비가 들어가요. 같은 달이 이미 있으면 파일 내용으로 바뀌어요.</p>
    <label class="filebtn">파일 고르기<input type="file" id="importfile" hidden></label></section>`;
}
function niceStep(max) { const raw = max / 4; const p = Math.pow(10, Math.floor(Math.log10(raw))); const n = raw / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p; }

/* ---------- render ---------- */
function render(force) {
  if (!S.user) return;
  const a = document.activeElement;
  if (!force && a && a.closest && a.closest("#app") && (a.tagName === "INPUT" || a.tagName === "SELECT") && a.id !== "q-name" && a.id !== "q-amt") { pendingRender = true; return; }
  pendingRender = false;
  const focusId = a && a.id && a.closest && a.closest("#app") ? a.id : null;
  const caret = focusId && a.selectionStart != null ? a.selectionStart : null;
  document.querySelectorAll(".me button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.me === S.me));
  document.querySelectorAll("nav.tabs a").forEach((x) => x.dataset.v === S.view ? x.setAttribute("aria-current", "page") : x.removeAttribute("aria-current"));
  if (!S.cur || !S.months[S.cur]) { const ks = monthKeys(); S.cur = ks.includes(currentKey()) ? currentKey() : ks[ks.length - 1] || null; }
  $("#app").innerHTML = { month: monthView, fixed: fixedView, invest: investView, trend: trendView }[S.view]();
  if (focusId) { const el = document.getElementById(focusId); if (el) { el.focus(); if (caret != null && el.setSelectionRange) try { el.setSelectionRange(caret, caret); } catch (e) {} } }
}
document.addEventListener("focusout", () => setTimeout(() => { if (pendingRender) render(); }, 0));

/* ---------- writes ---------- */
function patchMonth(k, obj) { S.months[k] = { ...S.months[k], ...obj }; const d = { ...obj }; return write(() => ref("months", k).set(d, { merge: true })); }

document.addEventListener("input", (e) => {
  const t = e.target;
  if (t.id === "q-name") { S.draft.name = t.value; if (!S.draft.catTouched) S.draft.cat = null; refreshAi(); }
  else if (t.id === "q-amt") S.draft.amt = t.value;
});
document.addEventListener("change", (e) => {
  const t = e.target;
  if (t.id === "jump") { S.cur = t.value; S.catFilter = null; render(true); return; }
  if (t.id === "q-who") { S.draft.who = t.value; return; }
  if (t.id === "importfile") { importFile(t.files[0]); t.value = ""; window.scrollTo(0, 0); return; }
  if (t.dataset.actChange === "pickcat") { if (t.value) { S.draft.cat = t.value; S.draft.catTouched = true; refreshAi(); } return; }
  const live = t.dataset.live; if (!live || !fs) return; const k = S.cur, m = S.months[k] || {};
  if (live === "park") patchMonth(k, { parking: parse(t.value) });
  else if (live === "fixedTotal") patchMonth(k, { fixedTotal: parse(t.value) });
  else if (live.startsWith("inc-")) { const inc = (m.incomes || []).map((x) => ({ ...x })); const i = +t.dataset.i; if (live === "inc-name") inc[i].name = t.value.trim(); else inc[i].amount = parse(t.value); patchMonth(k, { incomes: inc }); }
  else if (live.startsWith("inv-")) { const inv = (m.investments || []).map((x) => ({ ...x })); const i = +t.dataset.i; const f = live.slice(4); inv[i][f] = f === "account" ? t.value.trim() : parse(t.value); patchMonth(k, { investments: inv }); }
  render(true);
});

document.addEventListener("submit", async (e) => {
  const f = e.target; if (!f.dataset.form) return; e.preventDefault(); if (!fs) return;
  const fd = Object.fromEntries(new FormData(f)); const k = S.cur; const m = S.months[k] || {};
  if (f.dataset.form === "exp") {
    const amt = parse(fd.amt); if (!fd.name.trim() || amt == null) return;
    const sug = aiSuggest(fd.name); const auto = sug[0] ? sug[0].id : "etc";
    const cat = S.draft.catTouched ? S.draft.cat : auto;
    const doc = { month: k, name: fd.name.trim(), amount: amt, cat, catSource: S.draft.catTouched && cat !== auto ? "user" : "ai", who: fd.who, memo: "", ts: Date.now(), by: S.me };
    const r = fs.collection(COL.expenses).doc(); S.expenses.push({ id: r.id, ...doc }); modelDirty = true;
    S.draft = { name: "", amt: "", who: fd.who, cat: null, catTouched: false };
    render(true); const nm = $("#q-name"); nm && nm.focus();
    await write(() => r.set(doc));
  } else if (f.dataset.form === "editexp") {
    const id = f.dataset.id; const ex = S.expenses.find((x) => x.id === id); if (!ex) return;
    const upd = { name: fd.name.trim(), amount: parse(fd.amt) ?? 0, cat: fd.cat, who: fd.who, memo: fd.memo.trim() };
    if (fd.cat !== ex.cat) upd.catSource = "user";
    Object.assign(ex, upd); S.editExp = null; modelDirty = true; render(true);
    await write(() => ref("expenses", id).update(upd));
  } else if (f.dataset.form === "inc") {
    if (!fd.name.trim()) return; patchMonth(k, { incomes: [...(m.incomes || []), { name: fd.name.trim(), amount: parse(fd.amt) }] }); render(true);
  } else if (f.dataset.form === "inv") {
    if (!fd.name.trim()) return; patchMonth(k, { investments: [...(m.investments || []), { account: fd.name.trim(), principal: null, current: null }] }); render(true);
  } else if (f.dataset.form === "fixed") {
    const id = f.dataset.id; const body = { name: fd.name.trim(), amount: parse(fd.amt) ?? 0, payer: fd.payer, kind: fd.kind, principal: parse(fd.principal), start: fd.start || "", end: fd.end || "" };
    if (!body.name) return; S.editFixed = null;
    if (id) { Object.assign(S.fixed.find((x) => x.id === id), body); render(true); await write(() => ref("fixed", id).update(body)); }
    else { body.order = Math.max(0, ...S.fixed.map((x) => x.order || 0)) + 1; const r = fs.collection(COL.fixed).doc(); S.fixed.push({ id: r.id, ...body }); render(true); await write(() => r.set(body)); }
  }
});

document.addEventListener("click", async (e) => {
  const me = e.target.closest("[data-me]"); if (me) { S.me = me.dataset.me; S.draft.who = null; try { localStorage.setItem("me", S.me); } catch (_) {} render(true); return; }
  const b = e.target.closest("[data-act]"); if (!b || !fs) return; const act = b.dataset.act; const k = S.cur; const keys = monthKeys();
  if (act !== "delexp" && act !== "delfixed") S.armed = null;
  if (act === "prev" || act === "next") { const i = keys.indexOf(k) + (act === "prev" ? -1 : 1); if (keys[i]) { S.cur = keys[i]; S.catFilter = null; S.editExp = null; } render(true); }
  else if (act === "pickcat") { S.draft.cat = b.dataset.cat; S.draft.catTouched = true; refreshAi(); }
  else if (act === "filter") { S.catFilter = b.dataset.cat || null; render(true); }
  else if (act === "editexp") { S.editExp = b.dataset.id; render(true); }
  else if (act === "cancel") { S.editExp = null; S.editFixed = null; render(true); }
  else if (act === "delexp" || act === "delfixed") {
    const id = b.dataset.id; if (S.armed !== id) { S.armed = id; render(true); return; }
    S.armed = null;
    if (act === "delexp") { S.expenses = S.expenses.filter((x) => x.id !== id); S.editExp = null; modelDirty = true; render(true); await write(() => ref("expenses", id).delete()); }
    else { S.fixed = S.fixed.filter((x) => x.id !== id); S.editFixed = null; render(true); await write(() => ref("fixed", id).delete()); }
  }
  else if (act === "reviewyes" || act === "reviewno") {
    const id = b.dataset.id; const ex = S.expenses.find((x) => x.id === id); if (!ex) return;
    const upd = act === "reviewyes" ? { cat: b.dataset.cat, catSource: "user" } : { catSource: "user" };
    Object.assign(ex, upd); modelDirty = true; render(true); await write(() => ref("expenses", id).update(upd));
  }
  else if (act === "delinc") { patchMonth(k, { incomes: (S.months[k].incomes || []).filter((_, i) => i !== +b.dataset.i) }); render(true); }
  else if (act === "delinv") { patchMonth(k, { investments: (S.months[k].investments || []).filter((_, i) => i !== +b.dataset.i) }); render(true); }
  else if (act === "syncfixed") { patchMonth(k, { fixedTotal: fixedSum() }); render(true); }
  else if (act === "copyinv") { const src = S.months[b.dataset.from].investments || []; patchMonth(k, { investments: src.map((r) => ({ account: r.account, principal: r.principal, current: null })) }); render(true); }
  else if (act === "editfixed") { S.editFixed = b.dataset.id; render(true); }
  else if (act === "newfixed") { S.editFixed = "new"; render(true); }
  else if (act === "newmonth") {
    const last = keys[keys.length - 1]; const nk = last ? shiftKey(last, 1) : currentKey();
    const prev = last ? S.months[last] : null;
    const incomes = [{ name: "월급(진우)", amount: null }, { name: "월급(혜인)", amount: null }, { name: "이월(파킹통장)", amount: prev && prev.parking != null ? prev.parking : null }];
    const body = { incomes, fixedTotal: fixedSum(), parking: null, investments: [] };
    S.months[nk] = body; S.cur = nk; render(true); await write(() => ref("months", nk).set(body));
  }
});
document.addEventListener("keydown", (e) => { if ((e.key === "Enter" || e.key === " ") && e.target.matches(".exp[role=button]")) { e.preventDefault(); e.target.click(); } });

/* ---------- 가져오기 (예전 기록 한 번에 옮기기) ---------- */
async function importFile(file) {
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const all = [];
    for (const [col, docs] of Object.entries(data)) { if (!COL[col]) continue; for (const [id, body] of Object.entries(docs)) all.push([col, id, body]); }
    if (!all.length) { setStatus("가져올 기록이 파일에 없어요.", true); return; }
    setStatus(`${all.length}건을 옮기는 중…`);
    for (let i = 0; i < all.length; i += 400) {
      const batch = fs.batch();
      for (const [col, id, body] of all.slice(i, i + 400)) batch.set(ref(col, id), body);
      await batch.commit();
    }
    setStatus(`${all.length}건을 옮겼어요.`); setTimeout(() => setStatus(""), 4000);
  } catch (e) {
    setStatus(e && e.code === "permission-denied" ? "저장 권한이 없어요. Firebase 규칙에 이 구글 계정 이메일이 들어가 있고 '게시'됐는지 확인해 주세요." : "파일을 읽지 못했어요. 받은 가져오기 파일(.json)이 맞는지 확인해 주세요.", true);
  }
}

/* ---------- routing ---------- */
function route() { const h = (location.hash || "").slice(1); S.view = ["month", "fixed", "invest", "trend"].includes(h) ? h : "month"; S.editExp = null; S.editFixed = null; render(true); }
window.addEventListener("hashchange", route);

/* ---------- auth + data ---------- */
function showSignedIn(on) {
  $("#login").hidden = on; $("#tabs").hidden = !on; $(".me").hidden = !on; $("#signout").hidden = !on;
  if (!on) $("#app").innerHTML = "";
}
function subscribe() {
  const timer = setTimeout(() => setStatus("장부 서버에 아직 연결되지 않았어요. 인터넷 연결을 확인해 주세요.", true), 10000);
  const done = () => { if (S.loaded.m && S.loaded.e && S.loaded.f) { clearTimeout(timer); setStatus(""); } };
  const err = (e) => {
    clearTimeout(timer);
    if (e && e.code === "permission-denied") { setStatus(""); showSignedIn(false); const le = $("#loginerr"); le.hidden = false; le.textContent = `${S.user ? S.user.email : "이 계정"}은(는) 이 가계부에 등록되지 않은 계정이에요. 다른 계정으로 로그인해 주세요.`; unsubs.forEach((u) => u()); unsubs = []; auth.signOut(); }
    else setStatus("장부를 불러오지 못했어요. 새로고침해 주세요.", true);
  };
  unsubs.push(fs.collection(COL.months).onSnapshot((s) => { S.months = Object.fromEntries(s.docs.map((d) => [d.id, d.data()])); if (!s.metadata.fromCache) S.loaded.m = 1; done(); render(); }, err));
  unsubs.push(fs.collection(COL.expenses).onSnapshot((s) => { S.expenses = s.docs.map((d) => ({ id: d.id, ...d.data() })); modelDirty = true; if (!s.metadata.fromCache) S.loaded.e = 1; done(); render(); }, err));
  unsubs.push(fs.collection(COL.fixed).onSnapshot((s) => { S.fixed = s.docs.map((d) => ({ id: d.id, ...d.data() })); if (!s.metadata.fromCache) S.loaded.f = 1; done(); render(); }, err));
}

function boot() {
  if (!window.firebase || !window.WEDDING_FIREBASE_CONFIG) { setStatus("서버 연결 설정을 불러오지 못했어요. 새로고침해 주세요.", true); return; }
  const app = firebase.apps.length ? firebase.app() : firebase.initializeApp(window.WEDDING_FIREBASE_CONFIG);
  auth = app.auth(); fs = app.firestore();
  try { fs.enablePersistence({ synchronizeTabs: true }).catch(() => {}); } catch (e) {}
  if (/KAKAOTALK|Instagram|FBAN|FBAV|Line\//i.test(navigator.userAgent)) $("#inapp").hidden = false;
  $("#signin").addEventListener("click", async () => {
    $("#loginerr").hidden = true;
    const p = new firebase.auth.GoogleAuthProvider(); p.setCustomParameters({ prompt: "select_account" });
    try { await auth.signInWithPopup(p); }
    catch (e) {
      if (e && (e.code === "auth/popup-blocked" || e.code === "auth/operation-not-supported-in-this-environment")) { auth.signInWithRedirect(p); return; }
      if (e && e.code === "auth/popup-closed-by-user") return;
      const le = $("#loginerr"); le.hidden = false;
      le.textContent = e && e.code === "auth/unauthorized-domain" ? "Firebase에 이 사이트 주소가 아직 등록되지 않았어요. (설정 안내의 '승인된 도메인' 단계)" : "로그인하지 못했어요. 다시 시도해 주세요.";
    }
  });
  $("#signout").addEventListener("click", () => auth.signOut());
  auth.getRedirectResult().catch(() => {});
  auth.onAuthStateChanged((user) => {
    unsubs.forEach((u) => u()); unsubs = [];
    S.user = user; S.loaded = { m: 0, e: 0, f: 0 }; S.months = {}; S.expenses = []; S.fixed = [];
    if (!user) { setStatus(""); showSignedIn(false); return; }
    showSignedIn(true); setStatus("장부를 불러오는 중…"); route(); subscribe();
  });
}
boot();
})();

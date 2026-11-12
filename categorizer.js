/*
 * 지출 자동 분류기 — 우리 둘의 기록으로 학습하는 나이브 베이즈 분류기.
 *  - 단어 + 글자 2-gram(한글은 띄어쓰기가 들쭉날쭉해서)으로 특징을 만든다.
 *  - 사람이 직접 고친 분류(catSource "user")는 3배 가중치로 학습한다.
 *  - 기록이 적을 땐 기본 키워드 규칙이 힌트로 작동하고, 기록이 쌓일수록 학습 결과가 이긴다.
 * 브라우저 안에서만 계산하므로 외부로 나가는 데이터가 없다.
 */
(function (global) {
  const CATS = [
    { id: "living", name: "생활·장보기", c: "--c1" }, { id: "car", name: "교통·차량", c: "--c2" },
    { id: "wedding", name: "결혼·신혼", c: "--c3" }, { id: "home", name: "가구·가전·살림", c: "--c4" },
    { id: "travel", name: "여행", c: "--c5" }, { id: "gift", name: "경조사·선물", c: "--c6" },
    { id: "beauty", name: "꾸밈·쇼핑", c: "--c7" }, { id: "health", name: "의료", c: "--c8" },
    { id: "sub", name: "구독·통신", c: "--c9" }, { id: "hobby", name: "취미", c: "--c10" },
    { id: "transfer", name: "이체·카드값", c: "--c11" }, { id: "etc", name: "기타", c: "--c12" },
  ];
  const KW = [
    ["transfer", ["투자금", "대출금", "카드값", "환전", "이체"]],
    ["wedding", ["웨딩", "드레스", "스튜디오", "청첩", "사회자", "상견례", "신행", "신혼", "양복", "한복", "청모", "사설보정", "반지", "데모"]],
    ["travel", ["여행", "일본", "유럽", "유로", "숙박", "숙소", "비행기", "항공", "케이블카", "투어", "호텔", "유심", "면세", "에어비앤비"]],
    ["home", ["가전", "가구", "침대", "테이블", "이케아", "다이소", "콘센트", "세제", "도어락", "방충망", "시트지", "페인트", "센서등", "필터", "에어컨", "코웨이", "가스레인지", "신발장", "관리비", "공과금", "전기", "가스비", "수도"]],
    ["car", ["주유", "톨게이트", "통행료", "기차", "ktx", "srt", "택시", "대리", "교통", "자동차", "주차", "세차", "버스"]],
    ["gift", ["경조사", "선물", "용돈", "환갑", "꽃", "명절", "생신", "축의", "조의", "부조"]],
    ["beauty", ["미용실", "머리", "네일", "염색", "올리브영", "제모", "아울렛", "쇼핑", "옷", "신발", "무신사", "화장품"]],
    ["health", ["병원", "의료", "약국", "치과", "한의원", "홍삼", "영양제"]],
    ["sub", ["gpt", "chatgpt", "cursor", "통신", "핸드폰", "넷플릭스", "유튜브", "구독", "쿠팡와우"]],
    ["hobby", ["골프", "스크린", "헬스", "필라테스", "운동", "영화", "책"]],
    ["living", ["마트", "이마트", "홈플러스", "장보기", "편의점", "식비", "배달", "배민", "요기요", "카페", "스타벅스", "커피", "외식", "식당"]],
  ];
  const WEIGHT = { user: 3, ai: 1, rule: 1 };

  function tokens(name) {
    const clean = String(name || "").toLowerCase()
      .replace(/\d+\/\d+/g, " ")              // 11/14 같은 날짜 제거
      .replace(/[0-9]+/g, " ")
      .replace(/[()\[\],._\-+:;!?&·~/]/g, " ");
    const out = [];
    for (const w of clean.split(/\s+/).filter(Boolean)) {
      out.push("w:" + w);
      if (w.length >= 2) for (let i = 0; i < w.length - 1; i++) out.push("b:" + w.slice(i, i + 2));
      else out.push("b:" + w);
    }
    return out;
  }
  function ruleHits(name) {
    const n = String(name || "").toLowerCase();
    const hits = {};
    for (const [id, ws] of KW) if (ws.some((w) => n.includes(w))) hits[id] = (hits[id] || 0) + 1;
    return hits;
  }

  class Model {
    constructor() { this.reset(); }
    reset() { this.doc = {}; this.tok = {}; this.tot = {}; this.vocab = new Set(); this.n = 0; }
    add(name, cat, w, sign) {
      if (!cat) return;
      sign = sign || 1;
      this.doc[cat] = (this.doc[cat] || 0) + sign * w;
      this.n += sign * w;
      const tk = this.tok[cat] || (this.tok[cat] = {});
      for (const t of tokens(name)) {
        tk[t] = (tk[t] || 0) + sign * w;
        this.tot[cat] = (this.tot[cat] || 0) + sign * w;
        this.vocab.add(t);
      }
    }
    train(expenses) {
      this.reset();
      for (const e of expenses) this.add(e.name, e.cat || "etc", WEIGHT[e.catSource] || 1);
    }
    /** 가장 그럴듯한 분류 순서대로 [{id, p}] */
    predict(name, exclude) {
      const toks = tokens(name);
      if (!toks.length) return [];
      if (exclude) this.add(exclude.name, exclude.cat || "etc", WEIGHT[exclude.catSource] || 1, -1);
      const V = this.vocab.size + 1, a = 0.5, hits = ruleHits(name);
      const scores = CATS.map((c) => {
        const d = Math.max(0, this.doc[c.id] || 0);
        let s = Math.log((d + 1) / (this.n + CATS.length));
        const tk = this.tok[c.id] || {}, tot = Math.max(0, this.tot[c.id] || 0);
        for (const t of toks) s += Math.log((Math.max(0, tk[t] || 0) + a) / (tot + a * V));
        if (hits[c.id]) s += 2.2 * hits[c.id];     // 기본 키워드는 힌트 정도로만
        return { id: c.id, s };
      });
      if (exclude) this.add(exclude.name, exclude.cat || "etc", WEIGHT[exclude.catSource] || 1, 1);
      const m = Math.max(...scores.map((x) => x.s));
      const z = scores.reduce((t, x) => t + Math.exp(x.s - m), 0);
      return scores.map((x) => ({ id: x.id, p: Math.exp(x.s - m) / z })).sort((x, y) => y.p - x.p);
    }
  }

  function ruleOnly(name) {
    const h = ruleHits(name); let best = "etc", bc = 0;
    for (const [id, c] of Object.entries(h)) if (c > bc) { best = id; bc = c; }
    return best;
  }

  global.Categorizer = { CATS, Model, tokens, ruleOnly };
})(typeof window !== "undefined" ? window : globalThis);

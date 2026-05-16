/**
 * 한국어 성경 책 이름·줄임표 → vault 파일명 prefix 매핑 (66권).
 * vault wikilink 형식: [[{prefix}{장}_{절}]]  예) [[요3_16]], [[고전13_4]]
 */
interface BibleBook {
  /** wikilink prefix — 사용자 vault 파일명 규칙 */
  abbr: string;
  /** 풀이름·짧은이름·별칭 (정규식 alternation에 들어감, 긴 것부터) */
  aliases: string[];
}

export const BIBLE_BOOKS: BibleBook[] = [
  // 구약
  { abbr: "창", aliases: ["창세기", "창"] },
  { abbr: "출", aliases: ["출애굽기", "출"] },
  { abbr: "레", aliases: ["레위기", "레"] },
  { abbr: "민", aliases: ["민수기", "민"] },
  { abbr: "신", aliases: ["신명기", "신"] },
  { abbr: "수", aliases: ["여호수아", "수"] },
  { abbr: "삿", aliases: ["사사기", "삿"] },
  { abbr: "룻", aliases: ["룻기", "룻"] },
  { abbr: "삼상", aliases: ["사무엘상", "삼상"] },
  { abbr: "삼하", aliases: ["사무엘하", "삼하"] },
  { abbr: "왕상", aliases: ["열왕기상", "왕상"] },
  { abbr: "왕하", aliases: ["열왕기하", "왕하"] },
  { abbr: "대상", aliases: ["역대상", "대상"] },
  { abbr: "대하", aliases: ["역대하", "대하"] },
  { abbr: "스", aliases: ["에스라", "스"] },
  { abbr: "느", aliases: ["느헤미야", "느"] },
  { abbr: "에", aliases: ["에스더", "에"] },
  { abbr: "욥", aliases: ["욥기", "욥"] },
  { abbr: "시", aliases: ["시편", "시"] },
  { abbr: "잠", aliases: ["잠언", "잠"] },
  { abbr: "전", aliases: ["전도서", "전"] },
  { abbr: "아", aliases: ["아가", "아"] },
  { abbr: "사", aliases: ["이사야", "사"] },
  { abbr: "렘", aliases: ["예레미야", "렘"] },
  { abbr: "애", aliases: ["예레미야애가", "애가", "애"] },
  { abbr: "겔", aliases: ["에스겔", "겔"] },
  { abbr: "단", aliases: ["다니엘", "단"] },
  { abbr: "호", aliases: ["호세아", "호"] },
  { abbr: "욜", aliases: ["요엘", "욜"] },
  { abbr: "암", aliases: ["아모스", "암"] },
  { abbr: "옵", aliases: ["오바댜", "옵"] },
  { abbr: "욘", aliases: ["요나", "욘"] },
  { abbr: "미", aliases: ["미가", "미"] },
  { abbr: "나", aliases: ["나훔", "나"] },
  { abbr: "합", aliases: ["하박국", "합"] },
  { abbr: "습", aliases: ["스바냐", "습"] },
  { abbr: "학", aliases: ["학개", "학"] },
  { abbr: "슥", aliases: ["스가랴", "슥"] },
  { abbr: "말", aliases: ["말라기", "말"] },
  // 신약
  { abbr: "마", aliases: ["마태복음", "마"] },
  { abbr: "막", aliases: ["마가복음", "막"] },
  { abbr: "눅", aliases: ["누가복음", "눅"] },
  { abbr: "요", aliases: ["요한복음", "요"] },
  { abbr: "행", aliases: ["사도행전", "행"] },
  { abbr: "롬", aliases: ["로마서", "롬"] },
  { abbr: "고전", aliases: ["고린도전서", "고전"] },
  { abbr: "고후", aliases: ["고린도후서", "고후"] },
  { abbr: "갈", aliases: ["갈라디아서", "갈"] },
  { abbr: "엡", aliases: ["에베소서", "엡"] },
  { abbr: "빌", aliases: ["빌립보서", "빌"] },
  { abbr: "골", aliases: ["골로새서", "골"] },
  { abbr: "살전", aliases: ["데살로니가전서", "살전"] },
  { abbr: "살후", aliases: ["데살로니가후서", "살후"] },
  { abbr: "딤전", aliases: ["디모데전서", "딤전"] },
  { abbr: "딤후", aliases: ["디모데후서", "딤후"] },
  { abbr: "딛", aliases: ["디도서", "딛"] },
  { abbr: "몬", aliases: ["빌레몬서", "몬"] },
  { abbr: "히", aliases: ["히브리서", "히"] },
  { abbr: "약", aliases: ["야고보서", "약"] },
  { abbr: "벧전", aliases: ["베드로전서", "벧전"] },
  { abbr: "벧후", aliases: ["베드로후서", "벧후"] },
  { abbr: "요일", aliases: ["요한일서", "요일"] },
  { abbr: "요이", aliases: ["요한이서", "요이"] },
  { abbr: "요삼", aliases: ["요한삼서", "요삼"] },
  { abbr: "유", aliases: ["유다서", "유"] },
  { abbr: "계", aliases: ["요한계시록", "계"] },
];

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 별칭 → abbr 매핑 (긴 것부터 정렬해 정규식이 욕심내서 매치하도록) */
function buildAliasMap(): { aliases: string[]; toAbbr: Map<string, string> } {
  const toAbbr = new Map<string, string>();
  for (const b of BIBLE_BOOKS) {
    for (const a of b.aliases) toAbbr.set(a, b.abbr);
  }
  const aliases = Array.from(toAbbr.keys()).sort((a, b) => b.length - a.length);
  return { aliases, toAbbr };
}

const { aliases: ALIAS_LIST, toAbbr: ALIAS_TO_ABBR } = buildAliasMap();

/**
 * 한국어 성경 구절 인식 정규식.
 * 매치: (책이름)\s*(\d+)\s*[장편:]\s*(\d+)(?:\s*[-~–]\s*(\d+))?(?:절)?
 * 책이름 앞에 한글이 오면 매치하지 않음 (단어 일부와 매치 방지).
 */
const BIBLE_REF_REGEX = new RegExp(
  `(?<![가-힣])(${ALIAS_LIST.map(escapeRegex).join("|")})\\s*(\\d+)\\s*[장편:]\\s*(\\d+)(?:\\s*[-~–]\\s*(\\d+))?(?:절)?`,
  "g"
);

interface ConversionResult {
  text: string;
  count: number;
}

// 마스킹용 사설용 영역(PUA) 문자 — 본문에 절대 나타나지 않음
const CODE_MARK = "";
const WIKI_MARK = "";
const END_MARK = "";

/**
 * 입력 텍스트에서 한국어 성경 구절 표기를 [[abbr장_절]] 형식으로 변환.
 * 코드 블록(```...``` 또는 `...`)과 기존 wikilink([[...]]) 안쪽은 건드리지 않음.
 */
export function convertBibleRefsInText(text: string): ConversionResult {
  // 1) 코드 블록 마스킹
  const codeBlocks: string[] = [];
  let masked = text.replace(/```[\s\S]*?```|`[^`\n]*`/g, (m) => {
    const id = codeBlocks.length;
    codeBlocks.push(m);
    return `${CODE_MARK}${id}${END_MARK}`;
  });

  // 2) 기존 wikilink 마스킹
  const wikiLinks: string[] = [];
  masked = masked.replace(/\[\[[^\]\n]*\]\]/g, (m) => {
    const id = wikiLinks.length;
    wikiLinks.push(m);
    return `${WIKI_MARK}${id}${END_MARK}`;
  });

  // 3) 변환
  let count = 0;
  masked = masked.replace(
    BIBLE_REF_REGEX,
    (_match, name: string, ch: string, v1: string, v2: string | undefined) => {
      const abbr = ALIAS_TO_ABBR.get(name);
      if (!abbr) return _match;
      const chapter = parseInt(ch, 10);
      const verse1 = parseInt(v1, 10);
      if (!Number.isFinite(chapter) || !Number.isFinite(verse1)) return _match;
      const single = `[[${abbr}${chapter}_${verse1}]]`;
      if (v2 !== undefined) {
        const verse2 = parseInt(v2, 10);
        if (Number.isFinite(verse2) && verse2 > verse1) {
          count++;
          return `${single} ~ [[${abbr}${chapter}_${verse2}]]`;
        }
      }
      count++;
      return single;
    }
  );

  // 4) 복원 (wikilink → 코드블록 순)
  const wikiRe = new RegExp(`${WIKI_MARK}(\\d+)${END_MARK}`, "g");
  const codeRe = new RegExp(`${CODE_MARK}(\\d+)${END_MARK}`, "g");
  masked = masked.replace(wikiRe, (_, i) => wikiLinks[parseInt(i, 10)]);
  masked = masked.replace(codeRe, (_, i) => codeBlocks[parseInt(i, 10)]);

  return { text: masked, count };
}

/**
 * 노트 전체에서 frontmatter는 건드리지 않고 본문만 변환.
 */
export function convertBibleRefsInNote(content: string): ConversionResult {
  const fmMatch = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  const head = fmMatch ? fmMatch[0] : "";
  const body = fmMatch ? content.slice(fmMatch[0].length) : content;
  const { text, count } = convertBibleRefsInText(body);
  return { text: head + text, count };
}

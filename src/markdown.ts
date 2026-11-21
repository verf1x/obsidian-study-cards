import MarkdownIt from "markdown-it";
import { isMap, isScalar, isSeq, parseDocument, stringify, type YAMLMap, type YAMLSeq } from "yaml";

export type Format =
  | { mode: "single"; question: "heading" | "filename" }
  | { mode: "collection"; level: number };
export type Status = "new" | "studied" | "mastered";

export const single: Format = { mode: "single", question: "heading" };
export const statuses: Record<Status, string> = {
  new: "Не изучена",
  studied: "Изучена",
  mastered: "Выучена",
};

const markdown = new MarkdownIt({ html: true });
markdown.block.ruler.before("heading", "obsidian_comment", (state, start, end, silent) => {
  const line = (index: number) => state.src.slice(state.bMarks[index]! + state.tShift[index]!, state.eMarks[index]!);
  if (!line(start).startsWith("%%")) return false;
  if (silent) return true;
  let next = start + 1;
  if (!line(start).slice(2).includes("%%")) {
    while (next < end && !line(next++).includes("%%")) {
      // Find the first line that closes the comment.
    }
  }
  state.line = next;
  return true;
}, { alt: ["paragraph"] });

const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const statusPrefix = "qcards/status/";
const statusTag = /^(?:#)?qcards\/status(?:\/[\p{L}\p{N}_/-]*)?$/iu;
const collectionId = /^ {0,3}<!--[ \t]*qcards:id[ \t]*=[ \t]*(.*?)[ \t]*-->[ \t]*(?:\r?\n|$)/i;
const tagLine = /^ {0,3}(#[\p{L}\p{N}_/-]+(?:[ \t]+#[\p{L}\p{N}_/-]+)*)[ \t]*(?:\r?\n|$)/u;

interface Edit { from: number; to: number; text: string }
interface Heading { level: number; question: string; from: number; after: number }
export interface MarkdownCard {
  question: string;
  answer: string;
  from: number;
  to: number;
  id: string | null;
  invalidId: boolean;
  status: Status | "invalid";
}

function apply(source: string, edits: Edit[]) {
  for (const { from, to, text } of edits.sort((a, b) => b.from - a.from)) {
    source = source.slice(0, from) + text + source.slice(to);
  }
  return source;
}

function readStatus(tags: string[]): MarkdownCard["status"] {
  const values = new Set(tags.filter((tag) => statusTag.test(tag))
    .map((tag) => tag.replace(/^#/, "").toLowerCase().slice(statusPrefix.length)));
  if (!values.size) return "new";
  const [status] = values;
  return values.size === 1 && (status === "new" || status === "studied" || status === "mastered") ? status : "invalid";
}

function yamlValue(value: unknown) {
  return stringify(value, { collectionStyle: "flow", lineWidth: 0 }).trimEnd();
}

function tagTokens(value: unknown) {
  return typeof value === "string" ? value.split(/[\s,]+/).filter(Boolean) : [];
}

function trimBlankLines(markdown: string) {
  return markdown.replace(/^(?:[ \t]*\r?\n)+|(?:\r?\n[ \t]*)+$/g, "");
}

export function sameFormat(left: Format, right: Format) {
  if (left.mode === "single" && right.mode === "single") return left.question === right.question;
  return left.mode === "collection" && right.mode === "collection" && left.level === right.level;
}

export class MarkdownNote {
  readonly marked: boolean;
  readonly error: string | undefined;
  readonly eol: string;
  private readonly bom: number;
  private readonly bodyStart: number;
  private readonly yamlStart: number;
  private readonly yamlEnd: number;
  private readonly yaml;
  private readonly properties: YAMLMap | undefined;
  private parsedHeadings?: Heading[];
  private offsets?: number[];

  constructor(readonly path: string, readonly source: string) {
    this.bom = source.startsWith("\uFEFF") ? 1 : 0;
    this.eol = source.match(/\r?\n/)?.[0] ?? "\n";
    const frontmatter = /^---[ \t]*\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)/m.exec(source.slice(this.bom));
    const hasFrontmatter = frontmatter?.index === 0;
    this.yamlStart = hasFrontmatter ? source.indexOf("\n") + 1 : this.bom;
    this.yamlEnd = this.yamlStart + (hasFrontmatter ? frontmatter[1]!.length : 0);
    this.bodyStart = hasFrontmatter ? this.bom + frontmatter[0].length : this.bom;
    this.yaml = parseDocument(hasFrontmatter ? frontmatter[1]! : "", { version: "1.2", keepSourceTokens: true });
    this.properties = isMap(this.yaml.contents) ? this.yaml.contents : undefined;
    this.error = (this.yaml.errors.length || (this.yaml.contents && !this.properties)
      || (!hasFrontmatter && /^---[ \t]*\r?\n[^#\r\n]+:/.test(source.slice(this.bom))))
      ? "Проверьте YAML-свойства заметки" : undefined;
    this.marked = this.properties?.get("qcards_source") === true;
  }

  format(fallback: Format): Format {
    const mode = this.properties?.get("qcards_mode");
    const level = this.properties?.get("qcards_heading_level");
    const question = this.properties?.get("qcards_question");
    if (mode === "single" || (mode !== "collection" && fallback.mode === "single")) {
      return {
        mode: "single",
        question: question === "filename" || question === "heading" ? question
          : fallback.mode === "single" ? fallback.question : "heading",
      };
    }
    return {
      mode: "collection",
      level: typeof level === "number" && Number.isInteger(level) && level >= 1 && level <= 6 ? level
        : fallback.mode === "collection" ? fallback.level : 2,
    };
  }

  private headings() {
    if (this.parsedHeadings) return this.parsedHeadings;
    const body = this.source.slice(this.bodyStart);
    const offsets = [this.bodyStart, ...Array.from(body.matchAll(/\n/g), (match) => this.bodyStart + match.index + 1)];
    const tokens = markdown.parse(body, {});
    return this.parsedHeadings = tokens.flatMap((token, index) => token.type === "heading_open" && token.level === 0 && token.map
      ? [{
          level: Number(token.tag[1]),
          question: tokens[index + 1]!.content,
          from: offsets[token.map[0]]!,
          after: offsets[token.map[1]] ?? this.source.length,
        }]
      : []);
  }

  lineAt(offset: number) {
    this.offsets ??= [0, ...Array.from(this.source.matchAll(/\n/g), ({ index }) => index + 1)];
    let first = 0;
    let last = this.offsets.length;
    while (first + 1 < last) {
      const middle = Math.floor((first + last) / 2);
      if (this.offsets[middle]! <= offset) first = middle;
      else last = middle;
    }
    return first + 1;
  }

  cards(format: Format): MarkdownCard[] {
    const headings = this.headings();
    if (format.mode === "single") {
      const heading = format.question === "heading" ? headings.find(({ level }) => level === 1) : undefined;
      const id = this.properties?.get("qcards_id");
      return [{
        question: heading?.question ?? this.path.slice(this.path.lastIndexOf("/") + 1, -3),
        answer: trimBlankLines(this.source.slice(heading?.after ?? this.bodyStart)),
        from: heading?.from ?? this.bodyStart,
        to: this.source.length,
        id: typeof id === "string" && uuid.test(id) ? id.toLowerCase() : null,
        invalidId: this.properties?.has("qcards_id") === true && !(typeof id === "string" && uuid.test(id)),
        status: readStatus(this.tags()),
      }];
    }

    return this.sections(format.level, headings).map(({ heading, to, id, statusLine }) => {
      const content = this.source.slice(statusLine?.to ?? id?.to ?? heading.after, to);
      const rawId = id?.match[1];
      const validId = typeof rawId === "string" && uuid.test(rawId);
      const tags = statusLine?.match[1]?.split(/[ \t]+/) ?? [];
      const otherTags = tags.filter((tag) => !statusTag.test(tag));
      return {
        question: heading.question,
        answer: trimBlankLines(otherTags.length ? otherTags.join(" ") + this.eol + content : content),
        from: heading.from,
        to,
        id: validId ? rawId.toLowerCase() : null,
        invalidId: Boolean(id && !validId),
        status: readStatus(tags),
      };
    });
  }

  private sections(level: number, headings = this.headings()) {
    const boundaries = headings.filter((heading) => heading.level <= level);
    return boundaries.flatMap((heading, index) => {
      if (heading.level !== level) return [];
      const to = boundaries[index + 1]?.from ?? this.source.length;
      const range = (start: number, expression: RegExp) => {
        const rest = this.source.slice(start, to);
        const spacing = /^(?:[ \t]*\r?\n)*/.exec(rest)![0].length;
        const match = expression.exec(rest.slice(spacing));
        return match ? { from: start + spacing, to: start + spacing + match[0].length, match } : undefined;
      };
      const id = range(heading.after, collectionId);
      const candidate = range(id?.to ?? heading.after, tagLine);
      const statusLine = candidate?.match[1]?.split(/[ \t]+/).some((tag) => statusTag.test(tag)) ? candidate : undefined;
      return [{ heading, to, id, statusLine }];
    });
  }

  private tags(): string[] {
    const node = this.properties?.get("tags", true);
    const values = isSeq(node) ? node.items.map((item) => isScalar(item) ? item.value : undefined)
      : isScalar(node) ? [node.value] : [];
    return values.flatMap(tagTokens);
  }

  private writeSequenceStatus(node: YAMLSeq, tag: string) {
    const token = node.srcToken;
    if (token?.type !== "block-seq" && token?.type !== "flow-collection") return undefined;
    const edits: Edit[] = [];
    let replaced = false;
    for (const [index, item] of node.items.entries()) {
      if (!isScalar(item) || !item.range) continue;
      const tags = tagTokens(item.value);
      const retained = tags.filter((value) => !statusTag.test(value));
      if (retained.length === tags.length) continue;
      const [from, to, lineEnd] = item.range.map((offset) => this.yamlStart + offset) as [number, number, number];
      if (!replaced) {
        retained.push(tag);
        replaced = true;
      }
      if (retained.length) {
        edits.push({ from, to, text: yamlValue(retained.join(" ")) + (this.source[to - 1] === "\n" ? this.eol : "") });
      } else if (token.type === "block-seq") {
        const lineStart = this.source.lastIndexOf("\n", from - 1) + 1;
        if (!/^[ \t]*-[ \t]+$/.test(this.source.slice(lineStart, from))) return undefined;
        const comment = this.source.slice(to, lineEnd).trim();
        const indent = this.source.slice(lineStart, from).match(/^[ \t]*/)?.[0] ?? "";
        edits.push({ from: lineStart, to: lineEnd, text: comment ? indent + comment + this.eol : "" });
      } else {
        const comma = token.items[index]?.start.find(({ type }) => type === "comma");
        if (!comma) return undefined;
        edits.push({ from: this.yamlStart + comma.offset, to: this.yamlStart + comma.offset + 1, text: "" });
        edits.push({ from, to, text: "" });
      }
    }
    if (!replaced) {
      if (token.type === "block-seq" && node.range) {
        const from = this.yamlStart + node.range[1];
        edits.push({ from, to: from, text: " ".repeat(token.indent) + "- " + tag + this.eol });
      } else if (token.type === "flow-collection") {
        const last = node.items[node.items.length - 1];
        const from = this.yamlStart + (isScalar(last) && last.range ? last.range[1] : token.start.offset + 1);
        edits.push({ from, to: from, text: (last ? ", " : "") + tag });
      }
    }
    return apply(this.source, edits);
  }

  private writeProperties(fields: Record<string, unknown>): string {
    if (this.error) throw new Error(this.error);
    const edits: Edit[] = [];
    const added: string[] = [];
    for (const [key, value] of Object.entries(fields)) {
      const node = this.properties?.get(key, true);
      if (isScalar(node) && node.value === value) continue;
      const range = isScalar(node) || isSeq(node) || isMap(node) ? node.range : undefined;
      if (range && range[0] < range[1]) {
        const from = this.yamlStart + range[0];
        const previous = this.source.slice(from, this.yamlStart + range[1]);
        const multiline = /^(?:[|>][^\n]*\n|[^\n]*\n)/.test(previous);
        const lineStart = this.source.lastIndexOf("\n", from - 1) + 1;
        const onOwnLine = /^\s*$/.test(this.source.slice(lineStart, from));
        const rendered = yamlValue(value);
        edits.push({
          from,
          to: this.yamlStart + range[1],
          text: rendered + (multiline && previous.endsWith("\n") ? this.eol : ""),
        });
        if (onOwnLine && !this.properties?.flow && !this.source.slice(lineStart, from)) {
          edits[edits.length - 1]!.text = "  " + edits[edits.length - 1]!.text;
        }
      } else if (isScalar(node) && range) {
        edits.push({ from: this.yamlStart + range[0], to: this.yamlStart + range[0], text: " " + yamlValue(value) });
      } else if (node === undefined) {
        added.push(key + ": " + yamlValue(value));
      } else {
        throw new Error("Не удалось обновить свойство " + key);
      }
    }
    if (added.length) {
      if (this.properties?.flow && this.properties.range) {
        const end = this.yamlStart + this.properties.range[0] + 1;
        edits.push({ from: end, to: end, text: added.join(", ") + (this.properties.items.length ? ", " : "") });
      } else {
        const block = added.join(this.eol) + this.eol;
        const text = this.bodyStart === this.bom ? "---" + this.eol + block + "---" + this.eol : block;
        const documentEnd = /^\.\.\.[ \t]*(?:#.*)?\r?$/m.exec(this.source.slice(this.yamlStart, this.yamlEnd));
        const at = documentEnd ? this.yamlStart + documentEnd.index : this.yamlEnd;
        edits.push({ from: at, to: at, text });
      }
    }
    return apply(this.source, edits);
  }

  enroll(format: Format, assign: Map<number, string>) {
    const fields: Record<string, unknown> = { qcards_source: true, qcards_mode: format.mode };
    if (format.mode === "collection") fields.qcards_heading_level = format.level;
    else {
      fields.qcards_question = format.question;
      if (assign.has(0)) fields.qcards_id = assign.get(0);
    }
    const source = format.mode === "collection" ? this.writeIds(format.level, assign) : this.source;
    return new MarkdownNote(this.path, source).writeProperties(fields);
  }

  setId(format: Format, index: number, id: string) {
    return format.mode === "single" ? this.writeProperties({ qcards_id: id })
      : this.writeIds(format.level, new Map([[index, id]]));
  }

  private insertLine(at: number, line: string) {
    return (at > this.bodyStart && this.source[at - 1] !== "\n" ? this.eol : "") + line + this.eol;
  }

  private writeIds(level: number, ids: Map<number, string>) {
    const edits = this.sections(level).flatMap(({ heading, id }, index) => {
      const value = ids.get(index);
      if (!value) return [];
      const from = id?.from ?? heading.after;
      return [{ from, to: id?.to ?? from, text: this.insertLine(from, "<!-- qcards:id=" + value + " -->") }];
    });
    return apply(this.source, edits);
  }

  setStatus(format: Format, index: number, status: Status) {
    const tag = statusPrefix + status;
    if (format.mode === "single") {
      const node = this.properties?.get("tags", true);
      if (isSeq(node)) {
        const updated = this.writeSequenceStatus(node, tag);
        if (updated !== undefined) return updated;
      }
      const tags = this.tags().filter((value) => !statusTag.test(value));
      return this.writeProperties({ tags: [...tags, tag] });
    }
    const section = this.sections(format.level)[index];
    if (!section) throw new Error("Секция карточки изменилась");
    const { id, heading, statusLine } = section;
    const from = statusLine?.from ?? id?.to ?? heading.after;
    const tags = statusLine?.match[1]?.split(/[ \t]+/).filter((value) => !statusTag.test(value)) ?? [];
    return apply(this.source, [{
      from,
      to: statusLine?.to ?? from,
      text: this.insertLine(from, [...tags, "#" + tag].join(" ")),
    }]);
  }
}

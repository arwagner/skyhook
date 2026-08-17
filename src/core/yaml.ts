/**
 * A parser for the small, strict subset of YAML that skyhook's own config file uses:
 * nested maps of scalars, two-space indentation, `#` comments. Nothing else.
 *
 * Deliberately not a YAML implementation. It refuses anything outside the subset with
 * a message naming the line, rather than guessing — this file gates the environment cap,
 * and a config that quietly parses to something other than what it says is exactly the
 * silent failure the constitution forbids. Recorded as debt in `spec/backlog.md`:
 * a real parser belongs here once skyhook takes a dependency budget.
 */

export type YamlScalar = string | number | boolean | null;
export type YamlValue = YamlScalar | YamlMap;
export interface YamlMap {
  readonly [key: string]: YamlValue;
}

export type YamlOutcome =
  | { readonly ok: true; readonly value: YamlMap }
  | { readonly ok: false; readonly problems: readonly string[] };

const INDENT_WIDTH = 2;

export function parseYamlSubset(document: string): YamlOutcome {
  const problems: string[] = [];
  const root: Record<string, YamlValue> = {};
  const stack: { indent: number; map: Record<string, YamlValue> }[] = [{ indent: 0, map: root }];

  document.split('\n').forEach((rawLine, index) => {
    const lineNumber = index + 1;
    const line = rawLine.replace(/\r$/, '');
    if (line.trim() === '' || line.trimStart().startsWith('#')) return;

    const indent = line.length - line.trimStart().length;
    if (line.slice(0, indent).includes('\t')) {
      problems.push(`line ${lineNumber}: tabs are not valid indentation`);
      return;
    }
    if (indent % INDENT_WIDTH !== 0) {
      problems.push(`line ${lineNumber}: indentation must be a multiple of ${INDENT_WIDTH} spaces`);
      return;
    }

    const content = line.slice(indent);
    if (content.startsWith('- ')) {
      problems.push(`line ${lineNumber}: lists are not supported`);
      return;
    }

    const separator = content.indexOf(':');
    if (separator < 0) {
      problems.push(`line ${lineNumber}: expected "key: value"`);
      return;
    }
    const key = content.slice(0, separator).trim();
    if (key === '') {
      problems.push(`line ${lineNumber}: missing key`);
      return;
    }

    while (stack.length > 1 && indent < (stack.at(-1)?.indent ?? 0)) stack.pop();
    const frame = stack.at(-1);
    if (frame === undefined) return;
    if (indent !== frame.indent) {
      problems.push(`line ${lineNumber}: unexpected indentation`);
      return;
    }
    if (Object.hasOwn(frame.map, key)) {
      problems.push(`line ${lineNumber}: duplicate key "${key}"`);
      return;
    }

    const rest = stripComment(content.slice(separator + 1).trim());
    if (rest === '') {
      const child: Record<string, YamlValue> = {};
      frame.map[key] = child;
      stack.push({ indent: indent + INDENT_WIDTH, map: child });
      return;
    }
    const scalar = parseScalar(rest, lineNumber);
    if (typeof scalar === 'object' && scalar !== null) {
      problems.push(scalar.problem);
      return;
    }
    frame.map[key] = scalar;
  });

  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, value: root };
}

/** Strips an unquoted trailing `# comment`. A `#` inside quotes is content, not a comment. */
function stripComment(rest: string): string {
  if (rest.startsWith('"') || rest.startsWith("'")) return rest;
  const hash = rest.indexOf(' #');
  return hash < 0 ? rest : rest.slice(0, hash).trimEnd();
}

function parseScalar(text: string, lineNumber: number): YamlScalar | { problem: string } {
  const quote = text[0];
  if (quote === '"' || quote === "'") {
    if (text.length < 2 || !text.endsWith(quote)) {
      return { problem: `line ${lineNumber}: unterminated quoted string` };
    }
    return text.slice(1, -1);
  }
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === 'null' || text === '~') return null;
  if (/^-?\d+$/.test(text)) return Number.parseInt(text, 10);
  if (/^-?\d*\.\d+$/.test(text)) return Number.parseFloat(text);
  return text;
}

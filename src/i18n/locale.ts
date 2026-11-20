// Shared locale types, file filtering, and validation used by Vite, Node, and i18n-extract.
export interface LocaleInfo {
  code: string;
  label: string;
  intlLocale: string;
  htmlLang: string;
  wordSeparator: string;
}

export interface LocaleDefinition extends LocaleInfo {
  messages: Record<string, string>;
}

/** Shared file filter: only TypeScript modules (excluding declaration files). */
export function isLocaleFile(fileOrPath: string): boolean {
  const name = fileOrPath.split(/[\\/]/).pop() ?? fileOrPath;
  return name.endsWith('.ts') && !name.endsWith('.d.ts');
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Extracts and validates a locale module export. Returns an error mentioning `file` on failure. */
export function parseLocaleModule(mod: unknown, file: string): { ok: true; locale: LocaleDefinition } | { ok: false; error: string } {
  if (!isRecord(mod)) return { ok: false, error: `${file}: module must export an object` };

  let candidate: unknown;
  if ('default' in mod && mod.default !== undefined) {
    candidate = mod.default;
  } else {
    const objs = Object.values(mod).filter(isRecord);
    candidate = objs.find((v) => 'code' in v || 'messages' in v) ?? objs[0];
  }

  if (!isRecord(candidate)) {
    return { ok: false, error: `${file}: missing locale definition object` };
  }

  for (const field of ['code', 'label', 'intlLocale', 'htmlLang'] as const) {
    const val = candidate[field];
    if (typeof val !== 'string' || val.trim().length === 0) {
      return { ok: false, error: `${file}: "${field}" must be a non-empty string` };
    }
  }

  if (candidate.code === 'en') {
    return { ok: false, error: `${file}: locale code "en" is reserved for the built-in source language` };
  }

  if (typeof candidate.wordSeparator !== 'string') {
    return { ok: false, error: `${file}: "wordSeparator" must be a string` };
  }

  if (!isRecord(candidate.messages)) {
    return { ok: false, error: `${file}: "messages" must be an object` };
  }

  for (const [k, v] of Object.entries(candidate.messages)) {
    if (typeof v !== 'string') {
      return { ok: false, error: `${file}: messages[${JSON.stringify(k)}] must be a string` };
    }
  }

  return {
    ok: true,
    locale: {
      code: candidate.code as string,
      label: candidate.label as string,
      intlLocale: candidate.intlLocale as string,
      htmlLang: candidate.htmlLang as string,
      wordSeparator: candidate.wordSeparator,
      messages: candidate.messages as Record<string, string>,
    },
  };
}

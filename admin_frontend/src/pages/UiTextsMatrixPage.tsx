// FILE: ~/otmega/otmega_app/console/admin_frontend/src/pages/UiTextsMatrixPage.tsx
// ماموریت: صفحه spreadsheet کنسولی برای مشاهده، ویرایش موقت و خروجی گرفتن از کلیدهای UI Texts.

import { CheckSquare, Database, Download, Eye, EyeOff, FileCode2, FileSpreadsheet, Loader2, Plus, RefreshCw, RotateCcw, Search, Sparkles, Trash2, WrapText } from 'lucide-react';
import { useEffect, useMemo, useState, type CSSProperties, type MouseEvent } from 'react';
import {
  applyUiTextsMatrix,
  fetchUiTextsMatrix,
  fetchUiTextsLlmOptions,
  generateUiTextsAiSuggestions,
  generateUiTextsPatch,
  regenerateUiTextsFromEnglish,
  type UiTextsLanguageSummary,
  type UiTextsLlmOption,
  type UiTextsMatrix,
  type UiTextsPatchResponse,
  type UiTextsRegenerateResponse,
} from '../api/consoleApi';

const KEY_COLUMN = '__key__';
const DEFAULT_KEY_WIDTH = 320;
const DEFAULT_EN_WIDTH = 340;
const DEFAULT_LANGUAGE_WIDTH = 300;
const AI_FAST_CHUNK_SIZE = 12;
const AI_PRO_CHUNK_SIZE = 6;
const KEY_PATTERN = /^[A-Z0-9_]+$/;

type MatrixValues = Record<string, Record<string, string>>;
type ChangeMap = Record<string, Record<string, string>>;
type ColumnStats = Record<string, { active: number; empty: number; edited: number }>;
type AiCell = { key: string; language: string; english_text: string; current_text?: string };

function downloadText(filename: string, content: string, type = 'text/plain;charset=utf-8') {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function csvEscape(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function buildCsv(orderedKeys: string[], languages: string[], values: MatrixValues): string {
  const lines = [['key', ...languages].map(csvEscape).join(',')];
  for (const key of orderedKeys) {
    lines.push([key, ...languages.map((language) => values[language]?.[key] || '')].map(csvEscape).join(','));
  }
  return lines.join('\r\n');
}

function cloneMatrix(matrix: MatrixValues): MatrixValues {
  return Object.fromEntries(Object.entries(matrix).map(([language, values]) => [language, { ...values }]));
}

function buildMatrixValues(matrix: UiTextsMatrix): MatrixValues {
  const values: MatrixValues = Object.fromEntries(matrix.languages.map((language) => [language, {}]));
  for (const row of matrix.rows) {
    for (const language of matrix.languages) {
      values[language][row.key] = row.values[language] || '';
    }
  }
  return values;
}

function languageSummaryMap(summaries: UiTextsLanguageSummary[]) {
  return Object.fromEntries(summaries.map((summary) => [summary.code, summary]));
}

function rowMetaMap(matrix: UiTextsMatrix | null) {
  return Object.fromEntries((matrix?.rows || []).map((row) => [row.key, { category: row.category, subcategory: row.subcategory, orphan: row.orphan }]));
}

function cellId(language: string, key: string): string {
  return `${language}:${key}`;
}

function chunkCells(cells: AiCell[], size: number): AiCell[][] {
  const chunks: AiCell[][] = [];
  for (let index = 0; index < cells.length; index += size) {
    chunks.push(cells.slice(index, index + size));
  }
  return chunks;
}

export default function UiTextsMatrixPage() {
  const [matrix, setMatrix] = useState<UiTextsMatrix | null>(null);
  const [values, setValues] = useState<MatrixValues>({});
  const [changes, setChanges] = useState<ChangeMap>({});
  const [orderedKeys, setOrderedKeys] = useState<string[]>([]);
  const [hiddenLanguages, setHiddenLanguages] = useState<Set<string>>(new Set());
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({ [KEY_COLUMN]: DEFAULT_KEY_WIDTH, en: DEFAULT_EN_WIDTH });
  const [wrapCells, setWrapCells] = useState(true);
  const [search, setSearch] = useState('');
  const [showMissingOnly, setShowMissingOnly] = useState(false);
  const [newKey, setNewKey] = useState('');
  const [newEnglish, setNewEnglish] = useState('');
  const [generatedPatch, setGeneratedPatch] = useState<UiTextsPatchResponse | null>(null);
  const [llmOptions, setLlmOptions] = useState<UiTextsLlmOption[]>([]);
  const [selectedLlmKey, setSelectedLlmKey] = useState('');
  const [aiLanguages, setAiLanguages] = useState<Set<string>>(new Set());
  const [selectedCells, setSelectedCells] = useState<Set<string>>(new Set());
  const [aiGenerating, setAiGenerating] = useState(false);
  const [aiStatus, setAiStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyStatus, setApplyStatus] = useState<string | null>(null);
  const [regenLanguages, setRegenLanguages] = useState<Set<string>>(new Set());
  const [regenerating, setRegenerating] = useState(false);
  const [regenStatus, setRegenStatus] = useState<string | null>(null);
  const [regenResult, setRegenResult] = useState<UiTextsRegenerateResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadMatrix() {
    setLoading(true);
    setError(null);
    try {
      const response = await fetchUiTextsMatrix();
      const nextValues = buildMatrixValues(response.matrix);
      setMatrix(response.matrix);
      setValues(nextValues);
      setChanges({});
      setOrderedKeys(response.matrix.rows.map((row) => row.key));
      setGeneratedPatch(null);
      setColumnWidths((current) => ({
        [KEY_COLUMN]: current[KEY_COLUMN] || DEFAULT_KEY_WIDTH,
        ...Object.fromEntries(response.matrix.languages.map((language) => [language, current[language] || (language === 'en' ? DEFAULT_EN_WIDTH : DEFAULT_LANGUAGE_WIDTH)])),
      }));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Unable to load UI texts matrix.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadMatrix();
  }, []);

  useEffect(() => {
    async function loadLlmOptions() {
      try {
        const response = await fetchUiTextsLlmOptions();
        setLlmOptions(response.options);
        setSelectedLlmKey(response.active_option_key || response.options[0]?.key || '');
      } catch (nextError) {
        setAiStatus(nextError instanceof Error ? `AI options unavailable: ${nextError.message}` : 'AI options unavailable.');
      }
    }
    void loadLlmOptions();
  }, []);

  const summaries = useMemo(() => languageSummaryMap(matrix?.language_summaries || []), [matrix]);
  const rowMeta = useMemo(() => rowMetaMap(matrix), [matrix]);
  const visibleLanguages = useMemo(
    () => (matrix?.languages || []).filter((language) => language === 'en' || !hiddenLanguages.has(language)),
    [hiddenLanguages, matrix],
  );
  const changedCellCount = useMemo(() => Object.values(changes).reduce((total, languageChanges) => total + Object.keys(languageChanges).length, 0), [changes]);
  const emptyCellCount = useMemo(
    () => orderedKeys.reduce((total, key) => total + (matrix?.languages || []).filter((language) => !(values[language]?.[key] || '').trim()).length, 0),
    [matrix, orderedKeys, values],
  );
  const activeCellCount = useMemo(
    () => orderedKeys.reduce((total, key) => total + (matrix?.languages || []).filter((language) => Boolean((values[language]?.[key] || '').trim())).length, 0),
    [matrix, orderedKeys, values],
  );
  const columnStats = useMemo<ColumnStats>(
    () => Object.fromEntries((matrix?.languages || []).map((language) => {
      const active = orderedKeys.filter((key) => Boolean((values[language]?.[key] || '').trim())).length;
      const empty = orderedKeys.length - active;
      const edited = Object.keys(changes[language] || {}).length;
      return [language, { active, empty, edited }];
    })),
    [changes, matrix, orderedKeys, values],
  );
  const categoryCount = useMemo(() => new Set(orderedKeys.map((key) => rowMeta[key]?.category || 'Uncategorized')).size, [orderedKeys, rowMeta]);
  const englishKeyCount = useMemo(() => summaries.en?.key_count || 0, [summaries]);
  const syncInfo = useMemo(() => {
    const enCount = summaries.en?.key_count || 0;
    return (matrix?.languages || [])
      .filter((language) => language !== 'en')
      .map((language) => {
        const summary = summaries[language];
        const extras = summary?.missing_from_english.length || 0;
        const fileKeys = summary?.fallback_key_count || 0;
        const runtimeKeys = summary?.runtime_key_count ?? 0;
        const needsSync = extras > 0 || fileKeys !== enCount || runtimeKeys !== enCount;
        return { language, extras, fileKeys, runtimeKeys, needsSync };
      });
  }, [matrix, summaries]);
  const emptyAiCells = useMemo(() => {
    const cells: AiCell[] = [];
    for (const language of aiLanguages) {
      for (const key of orderedKeys) {
        const englishText = values.en?.[key] || '';
        const currentText = values[language]?.[key] || '';
        if (language !== 'en' && englishText.trim() && !currentText.trim()) {
          cells.push({ key, language, english_text: englishText, current_text: currentText });
        }
      }
    }
    return cells;
  }, [aiLanguages, orderedKeys, values]);
  const selectedAiCells = useMemo(() => {
    const cells: AiCell[] = [];
    for (const id of selectedCells) {
      const [language, ...keyParts] = id.split(':');
      const key = keyParts.join(':');
      const englishText = values.en?.[key] || '';
      if (language !== 'en' && englishText.trim()) {
        cells.push({ key, language, english_text: englishText, current_text: values[language]?.[key] || '' });
      }
    }
    return cells;
  }, [selectedCells, values]);
  const filteredKeys = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return orderedKeys.filter((key) => {
      const rowText = [key, ...visibleLanguages.map((language) => values[language]?.[key] || '')].join('\n').toLowerCase();
      const matchesSearch = !needle || rowText.includes(needle);
      const matchesMissing = !showMissingOnly || visibleLanguages.some((language) => !(values[language]?.[key] || '').trim());
      return matchesSearch && matchesMissing;
    });
  }, [orderedKeys, search, showMissingOnly, values, visibleLanguages]);

  function setCell(language: string, key: string, value: string) {
    setValues((current) => {
      const next = cloneMatrix(current);
      next[language] = { ...(next[language] || {}), [key]: value };
      return next;
    });
    const original = matrix?.rows.find((row) => row.key === key)?.values[language] || '';
    setChanges((current) => {
      const next: ChangeMap = Object.fromEntries(Object.entries(current).map(([lang, langChanges]) => [lang, { ...langChanges }]));
      if (value === original) {
        delete next[language]?.[key];
        if (next[language] && Object.keys(next[language]).length === 0) {
          delete next[language];
        }
      } else {
        next[language] = { ...(next[language] || {}), [key]: value };
      }
      return next;
    });
  }

  function addKey() {
    const key = newKey.trim().toUpperCase();
    if (!KEY_PATTERN.test(key) || orderedKeys.includes(key)) {
      return;
    }
    setOrderedKeys((current) => [...current, key]);
    setValues((current) => {
      const next = cloneMatrix(current);
      for (const language of matrix?.languages || []) {
        next[language] = { ...(next[language] || {}), [key]: language === 'en' ? newEnglish : '' };
      }
      return next;
    });
    setChanges((current) => ({ ...current, en: { ...(current.en || {}), [key]: newEnglish } }));
    setNewKey('');
    setNewEnglish('');
  }

  function removeKey(key: string) {
    setOrderedKeys((current) => current.filter((item) => item !== key));
    setChanges((current) => {
      const next: ChangeMap = Object.fromEntries(Object.entries(current).map(([language, languageChanges]) => [language, { ...languageChanges }]));
      for (const language of Object.keys(next)) {
        delete next[language][key];
        if (Object.keys(next[language]).length === 0) {
          delete next[language];
        }
      }
      return next;
    });
  }

  function toggleLanguage(language: string) {
    if (language === 'en') {
      return;
    }
    setHiddenLanguages((current) => {
      const next = new Set(current);
      if (next.has(language)) {
        next.delete(language);
      } else {
        next.add(language);
      }
      return next;
    });
  }

  function toggleAiLanguage(language: string) {
    if (language === 'en') {
      return;
    }
    setAiLanguages((current) => {
      const next = new Set(current);
      if (next.has(language)) {
        next.delete(language);
      } else {
        next.add(language);
      }
      return next;
    });
  }

  function toggleCellSelection(language: string, key: string) {
    if (language === 'en') {
      return;
    }
    const id = cellId(language, key);
    setSelectedCells((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function beginColumnResize(column: string, event: MouseEvent<HTMLSpanElement>) {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = columnWidths[column] || (column === KEY_COLUMN ? DEFAULT_KEY_WIDTH : DEFAULT_LANGUAGE_WIDTH);

    function handleMove(moveEvent: MouseEvent) {
      const width = Math.max(180, Math.min(620, startWidth + moveEvent.clientX - startX));
      setColumnWidths((current) => ({ ...current, [column]: width }));
    }

    function handleUp() {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    }

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
  }

  async function generatePatch() {
    setGenerating(true);
    setError(null);
    try {
      const response = await generateUiTextsPatch({ changes, matrix: values, ordered_keys: orderedKeys });
      setGeneratedPatch(response);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Unable to generate patch.');
    } finally {
      setGenerating(false);
    }
  }

  async function generateFinalPythonFiles() {
    setGenerating(true);
    setError(null);
    try {
      const response = await generateUiTextsPatch({
        changes,
        export_languages: matrix?.languages || [],
        matrix: values,
        ordered_keys: orderedKeys,
      });
      setGeneratedPatch(response);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Unable to generate final Python files.');
    } finally {
      setGenerating(false);
    }
  }

  async function applyMatrixDirectly() {
    if (!matrix || changedCellCount === 0) {
      return;
    }
    const changedLanguages = Object.keys(changes).sort();
    const confirmMessage = [
      'Apply UI texts directly?',
      '',
      `Changed cells: ${changedCellCount}`,
      `Languages: ${changedLanguages.join(', ')}`,
      '',
      'This will write final Python files in the application UI texts path and update config_domain_registry for the changed languages.',
      'Continue?',
    ].join('\n');
    if (!window.confirm(confirmMessage)) {
      setApplyStatus('Direct apply cancelled.');
      return;
    }

    setApplying(true);
    setApplyStatus(`Applying ${changedCellCount} changed cells...`);
    setError(null);
    try {
      const response = await applyUiTextsMatrix({ changes, matrix: values, ordered_keys: orderedKeys });
      setApplyStatus(`Applied ${response.applied_language_count} languages. Reloading matrix...`);
      await loadMatrix();
      setApplyStatus(`Applied and refreshed: ${response.applied_languages.join(', ')}`);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Unable to apply UI texts directly.');
      setApplyStatus(null);
    } finally {
      setApplying(false);
    }
  }

  function toggleRegenLanguage(language: string) {
    if (language === 'en') {
      return;
    }
    setRegenLanguages((current) => {
      const next = new Set(current);
      if (next.has(language)) {
        next.delete(language);
      } else {
        next.add(language);
      }
      return next;
    });
  }

  function selectAllSyncableLanguages() {
    setRegenLanguages(new Set(syncInfo.filter((info) => info.needsSync).map((info) => info.language)));
  }

  async function regenerateLanguages() {
    const languages = [...regenLanguages].filter((language) => language !== 'en').sort();
    if (languages.length === 0) {
      return;
    }
    const confirmMessage = [
      'Regenerate selected languages from English?',
      '',
      `Languages: ${languages.join(', ')}`,
      '',
      'For each language the key set is synced to English:',
      '- extra keys (not in English) are REMOVED from the .py file and config_domain_registry',
      '- missing English keys are added as empty',
      '- existing translations for shared keys are kept',
      '',
      'Continue?',
    ].join('\n');
    if (!window.confirm(confirmMessage)) {
      setRegenStatus('Regenerate cancelled.');
      return;
    }
    setRegenerating(true);
    setRegenStatus(`Regenerating ${languages.length} language(s) from English...`);
    setRegenResult(null);
    setError(null);
    try {
      const response = await regenerateUiTextsFromEnglish({ languages });
      setRegenResult(response);
      const removed = response.results.reduce((total, item) => total + item.removed_key_count, 0);
      setRegenLanguages(new Set());
      await loadMatrix();
      setRegenStatus(`Done: ${response.applied_languages.join(', ')} synced to English (${response.english_key_count} keys, ${removed} extra removed).`);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Unable to regenerate languages from English.');
      setRegenStatus(null);
    } finally {
      setRegenerating(false);
    }
  }

  async function applyAiSuggestions(cells: AiCell[], label: string) {
    if (!selectedLlmKey || cells.length === 0) {
      return;
    }
    const selectedOption = llmOptions.find((option) => option.key === selectedLlmKey);
    const modelName = selectedOption?.model || selectedOption?.label || selectedLlmKey;
    const initialChunkSize = modelName.toLowerCase().includes('pro') ? AI_PRO_CHUNK_SIZE : AI_FAST_CHUNK_SIZE;
    const missingSecret = selectedOption && !selectedOption.secret_available;
    const confirmMessage = `${label}\n\nModel: ${selectedOption?.label || selectedLlmKey}\nCells: ${cells.length}\nBatch size: ${initialChunkSize}${missingSecret ? '\n\nWarning: provider secret is not available in Cloud Run.' : ''}\n\nContinue?`;
    if (!window.confirm(confirmMessage)) {
      return;
    }
    setAiGenerating(true);
    setAiStatus(`Requesting AI suggestions for ${cells.length} cells...`);
    let applied = 0;
    let skipped = 0;
    const skippedSamples: string[] = [];

    async function requestChunk(chunk: AiCell[]) {
      try {
        const response = await generateUiTextsAiSuggestions({ model_option_key: selectedLlmKey, cells: chunk });
        const suggestedCells = new Set(response.suggestions.map((suggestion) => cellId(suggestion.language, suggestion.key)));
        for (const suggestion of response.suggestions) {
          setCell(suggestion.language, suggestion.key, suggestion.text);
          applied += 1;
        }
        const missingSuggestions = chunk.filter((cell) => !suggestedCells.has(cellId(cell.language, cell.key)));
        if (missingSuggestions.length > 0 && chunk.length > 1) {
          await requestChunk(missingSuggestions);
        } else if (missingSuggestions.length > 0) {
          skipped += missingSuggestions.length;
          skippedSamples.push(...missingSuggestions.slice(0, 3).map((cell) => `${cell.language}:${cell.key}`));
        }
        setAiStatus(`AI progress: ${applied} applied, ${skipped} skipped, ${cells.length - applied - skipped} remaining.`);
      } catch (nextError) {
        if (chunk.length > 1) {
          const midpoint = Math.ceil(chunk.length / 2);
          setAiStatus(`AI timeout on ${chunk.length} cells. Retrying smaller groups...`);
          await requestChunk(chunk.slice(0, midpoint));
          await requestChunk(chunk.slice(midpoint));
          return;
        }
        skipped += 1;
        const failedCell = chunk[0];
        const message = nextError instanceof Error ? nextError.message : 'provider error';
        skippedSamples.push(`${failedCell.language}:${failedCell.key} (${message})`);
        setAiStatus(`AI progress: ${applied} applied, ${skipped} skipped, ${cells.length - applied - skipped} remaining.`);
      }
    }

    try {
      for (const chunk of chunkCells(cells, initialChunkSize)) {
        await requestChunk(chunk);
      }
      if (skipped === 0) {
        setAiStatus(`Applied ${applied} editable AI suggestions.`);
      } else if (applied > 0) {
        const sample = skippedSamples.length > 0 ? ` Sample: ${skippedSamples.slice(0, 3).join(', ')}` : '';
        setAiStatus(`AI partial result: ${applied} applied, ${skipped} skipped.${sample}`);
      } else {
        const sample = skippedSamples.length > 0 ? ` Sample: ${skippedSamples.slice(0, 3).join(', ')}` : '';
        setAiStatus(`AI could not apply suggestions. ${skipped} cells skipped.${sample}`);
      }
    } finally {
      setAiGenerating(false);
    }
  }

  const keyWidth = columnWidths[KEY_COLUMN] || DEFAULT_KEY_WIDTH;
  const gridStyle = { '--ui-texts-key-width': `${keyWidth}px` } as CSSProperties;

  if (loading) {
    return (
      <div className="console-page ui-texts-page">
        <div className="console-panel ui-texts-loading"><Loader2 aria-hidden="true" className="spin" size={22} /> Loading UI texts matrix...</div>
      </div>
    );
  }

  return (
    <div className="console-page ui-texts-page">
      <div className="console-page-heading">
        <div>
          <h2>UI Texts Matrix</h2>
          <p>Spreadsheet workspace for language keys, Python exports, SQL patches, and controlled direct apply.</p>
        </div>
        <button className="console-secondary-button" disabled={applying} onClick={loadMatrix} type="button">
          <RefreshCw aria-hidden="true" size={16} />
          Reload from DB
        </button>
      </div>

      {error ? <div className="console-alert error">{error}</div> : null}

      <section className="console-panel ui-texts-toolbar">
        <label className="ui-texts-search">
          <Search aria-hidden="true" size={16} />
          <input onChange={(event) => setSearch(event.target.value)} placeholder="Search key or text" value={search} />
        </label>
        <button aria-pressed={showMissingOnly} className={showMissingOnly ? 'active' : ''} onClick={() => setShowMissingOnly((value) => !value)} type="button">
          Empty cells
        </button>
        <button aria-pressed={wrapCells} className={wrapCells ? 'active' : ''} onClick={() => setWrapCells((value) => !value)} type="button">
          <WrapText aria-hidden="true" size={16} />
          Wrap
        </button>
        <button disabled type="button" title="Reserved for future GCS import/export">
          GCS
        </button>
      </section>

      <section className="console-panel ui-texts-ai-panel">
        <div className="ui-texts-ai-head">
          <Sparkles aria-hidden="true" size={17} />
          <strong>AI suggestions</strong>
          <select disabled={aiGenerating || llmOptions.length === 0} onChange={(event) => setSelectedLlmKey(event.target.value)} value={selectedLlmKey}>
            {llmOptions.map((option) => (
              <option disabled={!option.secret_available} key={option.key} value={option.key}>
                {option.label} / {option.model}{option.secret_available ? '' : ' (secret missing)'}
              </option>
            ))}
          </select>
          <button disabled={aiGenerating || emptyAiCells.length === 0 || !selectedLlmKey} onClick={() => applyAiSuggestions(emptyAiCells, 'Fill empty cells for selected languages')} type="button">
            {aiGenerating ? <Loader2 aria-hidden="true" className="spin" size={16} /> : <Sparkles aria-hidden="true" size={16} />}
            Fill selected language empties ({emptyAiCells.length})
          </button>
          <button disabled={aiGenerating || selectedAiCells.length === 0 || !selectedLlmKey} onClick={() => applyAiSuggestions(selectedAiCells, 'Suggest translations for selected cells')} type="button">
            <CheckSquare aria-hidden="true" size={16} />
            Selected cells ({selectedAiCells.length})
          </button>
        </div>
        <div className="ui-texts-ai-languages">
          <button onClick={() => setAiLanguages(new Set((matrix?.languages || []).filter((language) => language !== 'en' && !hiddenLanguages.has(language))))} type="button">All visible</button>
          <button onClick={() => setAiLanguages(new Set())} type="button">Clear</button>
          {(matrix?.languages || []).filter((language) => language !== 'en').map((language) => (
            <label key={language}>
              <input checked={aiLanguages.has(language)} onChange={() => toggleAiLanguage(language)} type="checkbox" />
              <span>{language}</span>
              <small>{columnStats[language]?.empty || 0} empty</small>
            </label>
          ))}
        </div>
        {aiStatus ? <div className="ui-texts-ai-status">{aiStatus}</div> : null}
      </section>

      <section className="console-panel ui-texts-regenerate">
        <div className="ui-texts-ai-head">
          <RotateCcw aria-hidden="true" size={17} />
          <strong>Sync language to English</strong>
          <small>
            Regenerate a language from the English key set ({englishKeyCount} keys). Extra keys not in English are removed from the
            .py file and config_domain_registry, missing English keys are added empty, existing translations are kept.
          </small>
          <small className="ui-texts-regenerate-persist-note">
            Saved to the database immediately and permanently. The .py files are temporary on Cloud Run — to keep "file keys"
            correct after a redeploy, download the generated files and overwrite them in your local repo (exact paths shown after regenerate), then redeploy.
          </small>
        </div>
        <div className="ui-texts-ai-languages">
          <button onClick={selectAllSyncableLanguages} type="button">Select all needing sync</button>
          <button onClick={() => setRegenLanguages(new Set())} type="button">Clear</button>
          {syncInfo.map(({ language, extras, fileKeys, needsSync }) => (
            <label className={needsSync ? 'needs-sync' : ''} key={language}>
              <input checked={regenLanguages.has(language)} onChange={() => toggleRegenLanguage(language)} type="checkbox" />
              <span>{language}</span>
              <small>{extras} extra · {fileKeys}/{englishKeyCount} file</small>
            </label>
          ))}
        </div>
        <div className="ui-texts-regenerate-actions">
          <button disabled={regenerating || regenLanguages.size === 0} onClick={regenerateLanguages} type="button">
            {regenerating ? <Loader2 aria-hidden="true" className="spin" size={16} /> : <RotateCcw aria-hidden="true" size={16} />}
            Regenerate from English ({regenLanguages.size})
          </button>
          {regenStatus ? <span className="ui-texts-apply-status">{regenStatus}</span> : null}
        </div>
        {regenResult ? (
          <div className="ui-texts-regenerate-result">
            <div className="ui-texts-regenerate-howto">
              <strong>Make it permanent (so a redeploy keeps {regenResult.english_key_count} keys):</strong>
              <span>
                The database is already saved. Download each file below and overwrite the same-named file in BOTH local repo
                folders, then run your normal redeploy:
              </span>
              <ul>
                {regenResult.repo_dirs.map((dir) => (
                  <li key={dir}><code>{dir}/&lt;lang&gt;.py</code></li>
                ))}
              </ul>
            </div>
            <div className="ui-texts-regenerate-downloads">
              {regenResult.results.map((item) => (
                <button key={item.filename} onClick={() => downloadText(item.filename, item.content, 'text/x-python;charset=utf-8')} title={`Overwrite: ${item.repo_paths.join('  +  ')}`} type="button">
                  <Download aria-hidden="true" size={14} />
                  {item.filename} ({item.key_count} keys, -{item.removed_key_count})
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </section>

      <section className="console-panel ui-texts-add-row">
        <input onChange={(event) => setNewKey(event.target.value)} placeholder="NEW_TEXT_KEY" value={newKey} />
        <input onChange={(event) => setNewEnglish(event.target.value)} placeholder="English text for the new key" value={newEnglish} />
        <button disabled={!KEY_PATTERN.test(newKey.trim().toUpperCase()) || orderedKeys.includes(newKey.trim().toUpperCase()) || !newEnglish.trim()} onClick={addKey} type="button">
          <Plus aria-hidden="true" size={16} />
          Add key
        </button>
      </section>

      <section className="console-panel ui-texts-language-strip">
        {(matrix?.languages || []).map((language) => {
          const summary = summaries[language];
          const hidden = hiddenLanguages.has(language);
          return (
            <button aria-pressed={!hidden} className={hidden ? '' : 'active'} disabled={language === 'en'} key={language} onClick={() => toggleLanguage(language)} type="button">
              {hidden ? <EyeOff aria-hidden="true" size={15} /> : <Eye aria-hidden="true" size={15} />}
              <span>{language}</span>
              <small>{summary?.missing_from_language.length || 0} empty</small>
            </button>
          );
        })}
      </section>

      <section className="console-panel ui-texts-stats">
        <span>source: {matrix?.source || 'unknown'}</span>
        <span>{orderedKeys.length} keys</span>
        <span>{matrix?.languages.length || 0} languages</span>
        <span>{visibleLanguages.length} visible columns</span>
        <span>{changedCellCount} edited cells</span>
        <span>{emptyCellCount} empty cells</span>
        <span>{activeCellCount} active cells</span>
        <span>{categoryCount} categories</span>
        <span>{filteredKeys.length} shown rows</span>
      </section>

      <section className={`ui-texts-grid-wrap ${wrapCells ? 'wrap-cells' : 'nowrap-cells'}`} style={gridStyle}>
        <table className="ui-texts-grid">
          <thead>
            <tr>
              <th className="sticky-key" style={{ width: keyWidth, minWidth: keyWidth }}>
                <span>Row / Key</span>
                <small>{filteredKeys.length} shown / {orderedKeys.length} active</small>
                <span className="ui-texts-resizer" onMouseDown={(event) => beginColumnResize(KEY_COLUMN, event)} />
              </th>
              {visibleLanguages.map((language) => {
                const width = columnWidths[language] || DEFAULT_LANGUAGE_WIDTH;
                const summary = summaries[language];
                return (
                  <th className={language === 'en' ? 'english-column' : ''} key={language} style={{ width, minWidth: width }}>
                    <span>{language}</span>
                    <small>{columnStats[language]?.active || 0} active</small>
                    <small>{columnStats[language]?.empty || 0} empty</small>
                    <small>{columnStats[language]?.edited || 0} edited</small>
                    <small>{summary?.key_count || 0} effective keys</small>
                    <small>{summary?.runtime_key_count ?? 0} runtime keys</small>
                    <small>{summary?.fallback_key_count || 0} file keys</small>
                    <span className="ui-texts-resizer" onMouseDown={(event) => beginColumnResize(language, event)} />
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {filteredKeys.map((key, index) => (
              <tr key={key}>
                <td className="sticky-key ui-texts-key-cell" style={{ width: keyWidth, minWidth: keyWidth }}>
                  <span className="ui-texts-row-number">{index + 1}</span>
                  <div className="ui-texts-key-copy">
                    <small title={rowMeta[key]?.subcategory || rowMeta[key]?.category}>{rowMeta[key]?.category || 'Uncategorized'}</small>
                    <strong>{key}</strong>
                  </div>
                  <button onClick={() => removeKey(key)} title="Remove from this export workspace" type="button">
                    <Trash2 aria-hidden="true" size={14} />
                  </button>
                </td>
                {visibleLanguages.map((language) => {
                  const value = values[language]?.[key] || '';
                  const changed = Boolean(changes[language]?.[key] !== undefined);
                  return (
                    <td className={`${language === 'en' ? 'english-column' : ''} ${changed ? 'changed' : ''} ${value.trim() ? '' : 'missing'}`} key={`${language}:${key}`} style={{ width: columnWidths[language], minWidth: columnWidths[language] }}>
                      <textarea
                        aria-label={`${language} ${key}`}
                        onChange={(event) => setCell(language, key, event.target.value)}
                        value={value}
                      />
                      {language !== 'en' ? (
                        <label className="ui-texts-cell-select" title="Select this cell for AI suggestion">
                          <input checked={selectedCells.has(cellId(language, key))} onChange={() => toggleCellSelection(language, key)} type="checkbox" />
                        </label>
                      ) : null}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="console-panel ui-texts-export">
        <button onClick={() => downloadText('ui_texts_matrix.csv', buildCsv(orderedKeys, matrix?.languages || [], values), 'text/csv;charset=utf-8')} type="button">
          <FileSpreadsheet aria-hidden="true" size={16} />
          Download CSV
        </button>
        <button disabled={changedCellCount === 0 || generating} onClick={generatePatch} type="button">
          {generating ? <Loader2 aria-hidden="true" className="spin" size={16} /> : <FileCode2 aria-hidden="true" size={16} />}
          Generate SQL/Python patch
        </button>
        <button disabled={generating || !matrix} onClick={generateFinalPythonFiles} type="button">
          {generating ? <Loader2 aria-hidden="true" className="spin" size={16} /> : <FileCode2 aria-hidden="true" size={16} />}
          Generate final .py files
        </button>
        <button disabled={applying || generating || changedCellCount === 0 || !matrix} onClick={applyMatrixDirectly} type="button">
          {applying ? <span aria-hidden="true" className="wave-dots"><i /><i /><i /></span> : <Database aria-hidden="true" size={16} />}
          Apply DB + Python files
        </button>
        {applyStatus ? <span className="ui-texts-apply-status">{applyStatus}</span> : null}
        {generatedPatch ? (
          <>
            <span className="ui-texts-export-summary">
              {generatedPatch.changed_key_count} changed keys / {generatedPatch.python_files.length} Python files
            </span>
            <button onClick={() => downloadText('ui_texts_patch.sql', generatedPatch.sql_patch, 'application/sql;charset=utf-8')} type="button">
              <Download aria-hidden="true" size={16} />
              SQL
            </button>
            {generatedPatch.python_files.map((file) => (
              <button key={file.filename} onClick={() => downloadText(file.filename, file.content, 'text/x-python;charset=utf-8')} type="button">
                <Download aria-hidden="true" size={16} />
                {file.filename}
              </button>
            ))}
          </>
        ) : null}
      </section>

      {generatedPatch ? (
        <section className="console-panel ui-texts-patch-preview">
          <h3>Generated SQL patch</h3>
          <textarea readOnly value={generatedPatch.sql_patch} />
        </section>
      ) : null}
    </div>
  );
}

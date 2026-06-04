// FILE: ~/otmega/otmega_app/console/admin_frontend/src/pages/UiTextsMatrixPage.tsx
// ماموریت: صفحه spreadsheet کنسولی برای مشاهده، ویرایش موقت و خروجی گرفتن از کلیدهای UI Texts.

import { CheckSquare, Download, Eye, EyeOff, FileCode2, FileSpreadsheet, Loader2, Plus, RefreshCw, Search, Sparkles, Trash2, WrapText } from 'lucide-react';
import { useEffect, useMemo, useState, type CSSProperties, type MouseEvent } from 'react';
import {
  fetchUiTextsMatrix,
  fetchUiTextsLlmOptions,
  generateUiTextsAiSuggestions,
  generateUiTextsPatch,
  type UiTextsLanguageSummary,
  type UiTextsLlmOption,
  type UiTextsMatrix,
  type UiTextsPatchResponse,
} from '../api/consoleApi';

const KEY_COLUMN = '__key__';
const DEFAULT_KEY_WIDTH = 320;
const DEFAULT_EN_WIDTH = 340;
const DEFAULT_LANGUAGE_WIDTH = 300;
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

  async function applyAiSuggestions(cells: AiCell[], label: string) {
    if (!selectedLlmKey || cells.length === 0) {
      return;
    }
    const selectedOption = llmOptions.find((option) => option.key === selectedLlmKey);
    const missingSecret = selectedOption && !selectedOption.secret_available;
    const confirmMessage = `${label}\n\nModel: ${selectedOption?.label || selectedLlmKey}\nCells: ${cells.length}${missingSecret ? '\n\nWarning: provider secret is not available in Cloud Run.' : ''}\n\nContinue?`;
    if (!window.confirm(confirmMessage)) {
      return;
    }
    setAiGenerating(true);
    setAiStatus(`Requesting AI suggestions for ${cells.length} cells...`);
    try {
      let applied = 0;
      for (const chunk of chunkCells(cells, 200)) {
        const response = await generateUiTextsAiSuggestions({ model_option_key: selectedLlmKey, cells: chunk });
        for (const suggestion of response.suggestions) {
          setCell(suggestion.language, suggestion.key, suggestion.text);
          applied += 1;
        }
      }
      setAiStatus(`Applied ${applied} editable AI suggestions.`);
    } catch (nextError) {
      setAiStatus(nextError instanceof Error ? `AI failed: ${nextError.message}` : 'AI failed.');
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
          <p>Spreadsheet workspace for language keys. Phase 1 generates reviewable files and SQL only.</p>
        </div>
        <button className="console-secondary-button" onClick={loadMatrix} type="button">
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

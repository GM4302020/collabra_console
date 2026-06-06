// FILE: ~/otmega/otmega_app/console/admin_frontend/src/components/gcs/GcsBrowserPanel.tsx
// ماموریت: پنل مرور فایل‌های GCS با breadcrumb، پخش صدا و نمایش تصویر.

import {
  ChevronRight,
  File,
  FileAudio,
  FileImage,
  Folder,
  Home,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  browseGcsBucket,
  getGcsSignedUrl,
  requestTranscript,
  type GcsBrowseFile,
  type GcsBrowseFolder,
} from '../../api/consoleApi';

type MediaState =
  | { kind: 'idle' }
  | { kind: 'loading'; path: string }
  | { kind: 'audio'; path: string; url: string; mimeType: string }
  | { kind: 'image'; path: string; url: string }
  | { kind: 'error'; path: string; message: string };

type TranscriptState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | {
      kind: 'done';
      detectedLanguage: string;
      transcript: string;
      phoneticIpa: string | null;
      tone: string | null;
      speakingRate: string | null;
      speakerGender: string | null;
      audioQuality: string | null;
      backgroundNoise: string | null;
      speakerCount: number | null;
      confidence: string | null;
    }
  | { kind: 'error'; message: string };

function buildBreadcrumbs(prefix: string): Array<{ label: string; prefix: string }> {
  const crumbs: Array<{ label: string; prefix: string }> = [{ label: 'root', prefix: '' }];
  if (!prefix) return crumbs;
  const parts = prefix.split('/').filter(Boolean);
  let accumulated = '';
  for (const part of parts) {
    accumulated += `${part}/`;
    crumbs.push({ label: part, prefix: accumulated });
  }
  return crumbs;
}

export default function GcsBrowserPanel() {
  const [prefix, setPrefix] = useState('');
  const [folders, setFolders] = useState<GcsBrowseFolder[]>([]);
  const [files, setFiles] = useState<GcsBrowseFile[]>([]);
  const [nextPageToken, setNextPageToken] = useState<string | null>(null);
  const [bucket, setBucket] = useState('');
  const [loading, setLoading] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [media, setMedia] = useState<MediaState>({ kind: 'idle' });
  const [transcriptState, setTranscriptState] = useState<TranscriptState>({ kind: 'idle' });
  const audioRef = useRef<HTMLAudioElement>(null);

  const loadPrefix = useCallback(async (nextPrefix: string, pageToken?: string) => {
    setLoading(true);
    setBrowseError(null);
    if (!pageToken) {
      setFolders([]);
      setFiles([]);
      setNextPageToken(null);
    }
    try {
      const response = await browseGcsBucket({ prefix: nextPrefix, page_token: pageToken });
      setBucket(response.bucket);
      setFolders((current) => (pageToken ? [...current, ...response.folders] : response.folders));
      setFiles((current) => (pageToken ? [...current, ...response.files] : response.files));
      setNextPageToken(response.next_page_token);
      setPrefix(nextPrefix);
    } catch (error) {
      setBrowseError(error instanceof Error ? error.message : 'GCS browse failed.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadPrefix('');
  }, [loadPrefix]);

  async function handleFileClick(file: GcsBrowseFile) {
    if (!file.is_audio && !file.is_image) return;
    if (media.kind !== 'idle' && media.kind !== 'error' && (media as { path: string }).path === file.name) {
      setMedia({ kind: 'idle' });
      return;
    }
    setMedia({ kind: 'loading', path: file.name });
    try {
      const response = await getGcsSignedUrl(file.name);
      if (file.is_audio) {
        setMedia({ kind: 'audio', path: file.name, url: response.signed_url, mimeType: file.content_type || 'audio/mp3' });
        setTranscriptState({ kind: 'idle' });
      } else {
        setMedia({ kind: 'image', path: file.name, url: response.signed_url });
      }
    } catch (error) {
      setMedia({
        kind: 'error',
        path: file.name,
        message: error instanceof Error ? error.message : 'Failed to get signed URL.',
      });
    }
  }

  function handleFolderClick(folder: GcsBrowseFolder) {
    if (media.kind === 'audio' || media.kind === 'image') {
      setMedia({ kind: 'idle' });
      setTranscriptState({ kind: 'idle' });
    }
    void loadPrefix(folder.prefix);
  }

  function handleBreadcrumbClick(crumbPrefix: string) {
    if (crumbPrefix === prefix) return;
    if (media.kind === 'audio' || media.kind === 'image') {
      setMedia({ kind: 'idle' });
      setTranscriptState({ kind: 'idle' });
    }
    void loadPrefix(crumbPrefix);
  }

  async function handleTranscript() {
    if (media.kind !== 'audio') return;
    setTranscriptState({ kind: 'loading' });
    try {
      const result = await requestTranscript(media.path, media.mimeType);
      setTranscriptState({
        kind: 'done',
        detectedLanguage: result.data.detected_language,
        transcript: result.data.transcript,
        phoneticIpa: result.data.phonetic_ipa,
        tone: result.data.tone ?? null,
        speakingRate: result.data.speaking_rate ?? null,
        speakerGender: result.data.speaker_gender ?? null,
        audioQuality: result.data.audio_quality ?? null,
        backgroundNoise: result.data.background_noise ?? null,
        speakerCount: result.data.speaker_count ?? null,
        confidence: result.data.confidence ?? null,
      });
    } catch (error) {
      setTranscriptState({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Transcript request failed.',
      });
    }
  }

  const breadcrumbs = buildBreadcrumbs(prefix);
  const selectedPath = media.kind !== 'idle' ? (media as { path: string }).path : null;

  return (
    <div className="gcs-browser">
      <div className="gcs-browser-toolbar">
        <nav aria-label="GCS folder path" className="gcs-breadcrumb">
          {breadcrumbs.map((crumb, index) => (
            <span key={crumb.prefix} className="gcs-breadcrumb-item">
              {index > 0 && <ChevronRight aria-hidden="true" size={14} />}
              {index === 0 ? (
                <button onClick={() => handleBreadcrumbClick('')} title="Bucket root" type="button">
                  <Home aria-hidden="true" size={14} />
                  <span>{bucket || 'bucket'}</span>
                </button>
              ) : (
                <button
                  className={crumb.prefix === prefix ? 'active' : ''}
                  onClick={() => handleBreadcrumbClick(crumb.prefix)}
                  type="button"
                >
                  {crumb.label}
                </button>
              )}
            </span>
          ))}
        </nav>
        <button
          className="console-secondary-button"
          disabled={loading}
          onClick={() => loadPrefix(prefix)}
          title="Refresh"
          type="button"
        >
          {loading ? <Loader2 aria-hidden="true" className="spin" size={15} /> : <RefreshCw aria-hidden="true" size={15} />}
        </button>
      </div>

      {browseError ? <div className="console-alert error">{browseError}</div> : null}

      <div className="gcs-browser-list">
        {folders.length === 0 && files.length === 0 && !loading ? (
          <p className="gcs-browser-empty">This folder is empty.</p>
        ) : null}

        {folders.map((folder) => (
          <button
            className="gcs-browser-item gcs-folder"
            key={folder.prefix}
            onClick={() => handleFolderClick(folder)}
            type="button"
          >
            <Folder aria-hidden="true" size={17} />
            <span>{folder.short_name || folder.prefix}</span>
          </button>
        ))}

        {files.map((file) => {
          const isSelected = selectedPath === file.name;
          const isLoadingThis = media.kind === 'loading' && media.path === file.name;
          const clickable = file.is_audio || file.is_image;
          const Icon = file.is_audio ? FileAudio : file.is_image ? FileImage : File;
          return (
            <button
              aria-pressed={isSelected}
              className={`gcs-browser-item gcs-file ${isSelected ? 'selected' : ''} ${!clickable ? 'disabled' : ''}`}
              disabled={!clickable}
              key={file.name}
              onClick={() => handleFileClick(file)}
              title={file.name}
              type="button"
            >
              {isLoadingThis ? (
                <Loader2 aria-hidden="true" className="spin" size={17} />
              ) : (
                <Icon aria-hidden="true" size={17} />
              )}
              <span className="gcs-file-name">{file.short_name}</span>
              <small className="gcs-file-meta">{file.size_label}</small>
            </button>
          );
        })}
      </div>

      {nextPageToken ? (
        <div className="gcs-browser-more">
          <button
            className="console-secondary-button"
            disabled={loading}
            onClick={() => loadPrefix(prefix, nextPageToken)}
            type="button"
          >
            {loading ? <Loader2 aria-hidden="true" className="spin" size={15} /> : null}
            Load more
          </button>
        </div>
      ) : null}

      {media.kind === 'audio' ? (
        <div className="gcs-media-player">
          <p className="gcs-media-label">{media.path.split('/').pop()}</p>
          <audio
            autoPlay
            controls
            key={media.url}
            ref={audioRef}
            src={media.url}
            style={{ width: '100%' }}
          />
          <div className="gcs-transcript-actions">
            <button
              className="console-secondary-button"
              disabled={transcriptState.kind === 'loading'}
              onClick={() => void handleTranscript()}
              type="button"
            >
              {transcriptState.kind === 'loading' ? <Loader2 aria-hidden="true" className="spin" size={15} /> : null}
              Get Transcript
            </button>
          </div>
          {transcriptState.kind === 'done' ? (
            <div className="gcs-transcript-result">
              <div className="gcs-transcript-badges">
                <span className="gcs-transcript-lang-badge">{transcriptState.detectedLanguage}</span>
                {transcriptState.confidence ? <span className="gcs-transcript-badge">{transcriptState.confidence}</span> : null}
                {transcriptState.tone ? <span className="gcs-transcript-badge">{transcriptState.tone}</span> : null}
                {transcriptState.speakingRate ? <span className="gcs-transcript-badge">{transcriptState.speakingRate}</span> : null}
                {transcriptState.speakerGender ? <span className="gcs-transcript-badge">{transcriptState.speakerGender}</span> : null}
              </div>
              <p className="gcs-transcript-text">{transcriptState.transcript}</p>
              {transcriptState.phoneticIpa ? (
                <p className="gcs-transcript-ipa">{transcriptState.phoneticIpa}</p>
              ) : null}
              <div className="gcs-transcript-meta">
                {transcriptState.audioQuality ? <span>quality: {transcriptState.audioQuality}</span> : null}
                {transcriptState.backgroundNoise ? <span>noise: {transcriptState.backgroundNoise}</span> : null}
                {transcriptState.speakerCount != null ? <span>speakers: {transcriptState.speakerCount}</span> : null}
              </div>
            </div>
          ) : null}
          {transcriptState.kind === 'error' ? (
            <div className="console-alert error">{transcriptState.message}</div>
          ) : null}
        </div>
      ) : null}

      {media.kind === 'image' ? (
        <div className="gcs-media-viewer">
          <p className="gcs-media-label">{media.path.split('/').pop()}</p>
          <img alt={media.path.split('/').pop()} className="gcs-media-image" src={media.url} />
        </div>
      ) : null}

      {media.kind === 'error' ? (
        <div className="console-alert error">
          {media.path.split('/').pop()}: {media.message}
        </div>
      ) : null}
    </div>
  );
}

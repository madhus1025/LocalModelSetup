export interface TextDocumentSnapshot {
  path: string;
  content: string;
  version: number;
}

export interface TextSearchRequest {
  query: string;
  include?: string;
  exclude?: string;
  isRegex: boolean;
  isCaseSensitive: boolean;
  maxResults: number;
}

export interface TextSearchMatch {
  path: string;
  line: number;
  preview: string;
}

export interface SymbolMatch {
  name: string;
  kind: string;
  path: string;
  line: number;
  container?: string;
}

export interface DiagnosticSummary {
  path: string;
  line: number;
  severity: "error" | "warning" | "information" | "hint";
  message: string;
  source?: string;
  code?: string;
}

export interface EditorSnapshot {
  activeFile?: string;
  selection?: {
    startLine: number;
    endLine: number;
    text: string;
  };
  openFiles: string[];
  recentFiles: string[];
}

export interface WorkspaceFileChange {
  path: string;
  content?: string;
  delete?: boolean;
  create?: boolean;
}

export interface WorkspaceService {
  readonly roots: readonly string[];
  listFiles(pattern: string, maxResults: number): Promise<string[]>;
  readText(path: string): Promise<TextDocumentSnapshot>;
  exists(path: string): Promise<boolean>;
  writeText(path: string, content: string): Promise<void>;
  deleteFile(path: string): Promise<void>;
  applyChanges(changes: WorkspaceFileChange[]): Promise<void>;
  searchText(request: TextSearchRequest): Promise<TextSearchMatch[]>;
  findSymbols(query: string, maxResults: number): Promise<SymbolMatch[]>;
  getDiagnostics(maxResults: number): DiagnosticSummary[];
  getEditorSnapshot(): EditorSnapshot;
  getFormattedText(path: string): Promise<string>;
  reveal(path: string, line?: number): Promise<void>;
  toAbsolutePath(path: string, forWrite?: boolean): Promise<string>;
  toDisplayPath(absolutePath: string): string;
}

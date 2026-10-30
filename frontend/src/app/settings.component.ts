import { Component, DestroyRef, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ApiService } from './api.service';
import { FileEntry, FileRead, GitStatusResponse, SearchResult, WorkspaceRead } from './models';

@Component({
  selector: 'app-settings', standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './settings.component.html', styleUrls: ['./settings.component.scss'],
})
export class SettingsComponent implements OnInit {
  workspaces: WorkspaceRead[] = [];
  selectedWorkspace: WorkspaceRead | null = null;
  workspacePath = '';
  workspaceName = '';
  explorerPath = '';
  fileEntries: FileEntry[] = [];
  selectedFile: FileRead | null = null;
  searchQuery = '';
  searchedQuery = '';
  searchResults: SearchResult[] = [];
  gitStatus: GitStatusResponse | null = null;
  gitDiff = '';
  error: string | null = null;
  loadingWorkspaces = false;
  registering = false;
  loadingFiles = false;
  loadingFile = false;
  searching = false;
  fileHasMore = false;
  searchHasMore = false;
  removeId: number | null = null;
  removing = false;
  private readonly destroyRef = inject(DestroyRef);
  private selectionId = 0;
  private explorerRequestId = 0;
  private fileRequestId = 0;
  private searchRequestId = 0;
  private workspaceListRequestId = 0;
  private gitStatusRequestId = 0;
  private filePage = 1;
  private searchPage = 1;

  constructor(private readonly api: ApiService) {}

  ngOnInit(): void { if (this.api.isBrowser) this.loadWorkspaces(); }

  loadWorkspaces(): void {
    const request = ++this.workspaceListRequestId;
    this.loadingWorkspaces = true;
    this.api.listWorkspaces().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: items => { if (request !== this.workspaceListRequestId) return; this.workspaces = items; this.loadingWorkspaces = false; if (!this.selectedWorkspace && items.length) this.selectWorkspace(items[0]); },
      error: () => { if (request !== this.workspaceListRequestId) return; this.error = 'Could not load local workspaces. Check the backend connection and retry.'; this.loadingWorkspaces = false; },
    });
  }

  registerWorkspace(): void {
    if (!this.workspacePath.trim() || this.registering) return;
    this.error = null;
    this.registering = true;
    this.api.createWorkspace(this.workspacePath.trim(), this.workspaceName.trim() || undefined).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: workspace => {
        this.workspaceListRequestId++;
        this.loadingWorkspaces = false;
        this.workspaces = [workspace, ...this.workspaces.filter(item => item.id !== workspace.id)];
        this.selectWorkspace(workspace);
        this.workspacePath = ''; this.workspaceName = ''; this.registering = false;
      },
      error: () => { this.error = 'Could not add this workspace. Enter an existing absolute folder path on the backend machine.'; this.registering = false; },
    });
  }

  selectWorkspace(workspace: WorkspaceRead): void {
    this.selectionId++;
    this.explorerRequestId++; this.fileRequestId++; this.searchRequestId++;
    this.selectedWorkspace = workspace;
    this.explorerPath = ''; this.fileEntries = []; this.selectedFile = null;
    this.searchQuery = ''; this.searchedQuery = ''; this.searchResults = [];
    this.gitDiff = ''; this.gitStatus = null; this.error = null;
    this.fileHasMore = false; this.searchHasMore = false;
    this.loadingFile = false; this.searching = false;
    this.loadExplorer(); this.loadGitStatus();
  }

  removeWorkspace(workspaceId: number): void {
    if (this.removing) return;
    this.removing = true;
    this.api.deleteWorkspace(workspaceId).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.workspaceListRequestId++;
        this.loadingWorkspaces = false;
        this.workspaces = this.workspaces.filter(item => item.id !== workspaceId);
        this.removeId = null; this.removing = false;
        if (this.selectedWorkspace?.id === workspaceId) {
          this.selectionId++; this.explorerRequestId++; this.fileRequestId++; this.searchRequestId++;
          this.selectedWorkspace = null; this.fileEntries = []; this.selectedFile = null; this.gitStatus = null;
          this.gitDiff = ''; this.searchResults = []; this.loadingFiles = false; this.loadingFile = false; this.searching = false;
          if (this.workspaces.length) this.selectWorkspace(this.workspaces[0]);
        }
      },
      error: () => { this.error = 'Could not remove the workspace registration.'; this.removing = false; },
    });
  }

  loadExplorer(more = false): void {
    if (!this.selectedWorkspace || (more && this.loadingFiles)) return;
    const selection = this.selectionId;
    const request = ++this.explorerRequestId;
    const page = more ? this.filePage + 1 : 1;
    this.loadingFiles = true;
    if (!more) { this.fileEntries = []; this.fileHasMore = false; }
    this.api.listFiles(this.selectedWorkspace.id, this.explorerPath || undefined, page).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: result => {
        if (selection !== this.selectionId || request !== this.explorerRequestId) return;
        this.fileEntries = more ? [...this.fileEntries, ...result.entries] : result.entries;
        this.filePage = page; this.fileHasMore = result.has_more; this.loadingFiles = false;
      },
      error: () => {
        if (selection !== this.selectionId || request !== this.explorerRequestId) return;
        this.error = 'Could not load this folder. Try refreshing files.'; this.loadingFiles = false;
      },
    });
  }

  goUp(): void {
    if (!this.explorerPath) return;
    this.explorerPath = this.explorerPath.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
    this.loadExplorer();
  }

  goToRoot(): void { this.explorerPath = ''; this.loadExplorer(); }

  openEntry(entry: FileEntry): void {
    if (!this.selectedWorkspace) return;
    if (entry.is_dir) { this.explorerPath = entry.path; this.loadExplorer(); return; }
    this.openFile(entry.path);
  }

  openFile(path: string): void {
    if (!this.selectedWorkspace) return;
    const selection = this.selectionId;
    const request = ++this.fileRequestId;
    this.loadingFile = true; this.selectedFile = null; this.gitDiff = '';
    this.api.readFile(this.selectedWorkspace.id, path).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: file => {
        if (selection !== this.selectionId || request !== this.fileRequestId) return;
        this.selectedFile = file; this.loadingFile = false; this.loadGitDiff(path, request);
      },
      error: () => {
        if (selection !== this.selectionId || request !== this.fileRequestId) return;
        this.error = 'Could not preview this file. It may be excluded, too large, or no longer available.'; this.loadingFile = false;
      },
    });
  }

  searchWorkspace(more = false): void {
    if (!this.selectedWorkspace || !this.searchQuery.trim() || (more && this.searching)) return;
    const selection = this.selectionId;
    const request = ++this.searchRequestId;
    const query = more ? this.searchedQuery : this.searchQuery.trim();
    const page = more ? this.searchPage + 1 : 1;
    this.searching = true;
    if (!more) { this.searchResults = []; this.searchedQuery = query; this.searchHasMore = false; }
    this.api.searchWorkspace(this.selectedWorkspace.id, query, page).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: result => {
        if (selection !== this.selectionId || request !== this.searchRequestId) return;
        this.searchResults = more ? [...this.searchResults, ...result.results] : result.results;
        this.searchPage = page; this.searchHasMore = result.has_more; this.searching = false;
      },
      error: () => {
        if (selection !== this.selectionId || request !== this.searchRequestId) return;
        this.error = 'Could not search this workspace. Check that ripgrep is installed on the backend machine.'; this.searching = false;
      },
    });
  }

  loadGitStatus(): void {
    if (!this.selectedWorkspace) return;
    const selection = this.selectionId;
    const request = ++this.gitStatusRequestId;
    this.api.getGitStatus(this.selectedWorkspace.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: status => { if (selection === this.selectionId && request === this.gitStatusRequestId) this.gitStatus = status; },
      error: () => { if (selection === this.selectionId && request === this.gitStatusRequestId) this.gitStatus = null; },
    });
  }

  private loadGitDiff(path: string, request: number): void {
    if (!this.selectedWorkspace) return;
    const selection = this.selectionId;
    this.api.getGitDiff(this.selectedWorkspace.id, path).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: response => { if (selection === this.selectionId && request === this.fileRequestId) this.gitDiff = response.diff || ''; },
      error: () => { if (selection === this.selectionId && request === this.fileRequestId) this.gitDiff = ''; },
    });
  }
}

import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatCardModule } from '@angular/material/card';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatListModule } from '@angular/material/list';
import { MatFormFieldModule } from '@angular/material/form-field';
import { RouterLink } from '@angular/router';

import { ApiService } from './api.service';
import {
  FileEntry,
  FileRead,
  GitStatusResponse,
  SearchResult,
  WorkspaceRead,
} from './models';

@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [CommonModule, FormsModule, MatCardModule, MatButtonModule, MatIconModule, MatInputModule, MatFormFieldModule, MatListModule, RouterLink],
  templateUrl: './settings.component.html',
  styleUrls: ['./settings.component.scss'],
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
  searchResults: SearchResult[] = [];
  gitStatus: GitStatusResponse | null = null;
  gitDiff = '';
  error: string | null = null;

  constructor(private readonly api: ApiService) {}

  ngOnInit(): void {
    this.loadWorkspaces();
  }

  loadWorkspaces(): void {
    this.api.listWorkspaces().subscribe({
      next: (items) => {
        this.workspaces = items;
        if (!this.selectedWorkspace && items.length > 0) {
          this.selectWorkspace(items[0]);
        }
      },
      error: () => {
        this.error = 'Unable to load registered workspaces.';
      },
    });
  }

  registerWorkspace(): void {
    this.error = null;
    this.api.createWorkspace(this.workspacePath || undefined, this.workspaceName || undefined).subscribe({
      next: (workspace) => {
        this.workspaces = [workspace, ...this.workspaces.filter((item) => item.id !== workspace.id)];
        this.selectWorkspace(workspace);
        this.workspacePath = '';
        this.workspaceName = '';
      },
      error: () => {
        this.error = 'Unable to register workspace. Check the path and permissions.';
      },
    });
  }

  selectWorkspace(workspace: WorkspaceRead): void {
    this.selectedWorkspace = workspace;
    this.explorerPath = '';
    this.selectedFile = null;
    this.searchResults = [];
    this.gitDiff = '';
    this.loadExplorer();
    this.loadGitStatus();
  }

  removeWorkspace(workspaceId: number): void {
    this.api.deleteWorkspace(workspaceId).subscribe({
      next: () => {
        this.workspaces = this.workspaces.filter((item) => item.id !== workspaceId);
        if (this.selectedWorkspace?.id === workspaceId) {
          this.selectedWorkspace = null;
          this.fileEntries = [];
          this.selectedFile = null;
        }
      },
      error: () => {
        this.error = 'Unable to remove workspace.';
      },
    });
  }

  loadExplorer(): void {
    if (!this.selectedWorkspace) {
      return;
    }
    this.api.listFiles(this.selectedWorkspace.id, this.explorerPath || undefined).subscribe({
      next: (result) => {
        this.fileEntries = result.entries;
      },
      error: () => {
        this.error = 'Unable to load workspace files.';
      },
    });
  }

  openEntry(entry: FileEntry): void {
    if (!this.selectedWorkspace) {
      return;
    }
    if (entry.is_dir) {
      this.explorerPath = entry.path;
      this.loadExplorer();
      return;
    }
    this.api.readFile(this.selectedWorkspace.id, entry.path).subscribe({
      next: (file) => {
        this.selectedFile = file;
        this.loadGitDiff(entry.path);
      },
      error: () => {
        this.error = 'Unable to load file content.';
      },
    });
  }

  searchWorkspace(): void {
    if (!this.selectedWorkspace || !this.searchQuery.trim()) {
      return;
    }
    this.api.searchWorkspace(this.selectedWorkspace.id, this.searchQuery.trim()).subscribe({
      next: (result) => {
        this.searchResults = result.results;
      },
      error: () => {
        this.error = 'Unable to search workspace.';
      },
    });
  }

  loadGitStatus(): void {
    if (!this.selectedWorkspace) {
      return;
    }
    this.api.getGitStatus(this.selectedWorkspace.id).subscribe({
      next: (status) => {
        this.gitStatus = status;
      },
      error: () => {
        this.gitStatus = null;
      },
    });
  }

  loadGitDiff(path: string): void {
    if (!this.selectedWorkspace) {
      return;
    }
    this.api.getGitDiff(this.selectedWorkspace.id, path).subscribe({
      next: (response) => {
        this.gitDiff = response.diff || '';
      },
      error: () => {
        this.gitDiff = '';
      },
    });
  }
}

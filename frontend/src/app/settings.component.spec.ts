import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, Subject } from 'rxjs';
import { ApiService } from './api.service';
import { SettingsComponent } from './settings.component';
import { FileRead, GitStatusResponse, WorkspaceRead } from './models';

const workspace = (id: number): WorkspaceRead => ({ id, display_name: 'Repository ' + id, root_path: 'C:/Projects/' + id, created_at: '', updated_at: '' });
const file = (path: string): FileRead => ({ path, content: path, metadata: { path, is_dir: false, size: 1, modified_at: '' } });

describe('SettingsComponent repository navigation', () => {
  let fixture: ComponentFixture<SettingsComponent>;
  let component: SettingsComponent;
  let api: jasmine.SpyObj<ApiService>;
  beforeEach(async () => {
    api = jasmine.createSpyObj<ApiService>('ApiService', ['listWorkspaces', 'createWorkspace', 'deleteWorkspace', 'listFiles', 'getGitStatus', 'readFile', 'getGitDiff', 'searchWorkspace'], { isBrowser: true });
    api.listWorkspaces.and.returnValue(of([]));
    api.listFiles.and.returnValue(of({ entries: [], page: 1, page_size: 50, has_more: false }));
    api.getGitStatus.and.returnValue(of({ is_git: true, status: [] }));
    api.getGitDiff.and.returnValue(of({ path: '', diff: '' }));
    await TestBed.configureTestingModule({ imports: [SettingsComponent], providers: [provideRouter([]), { provide: ApiService, useValue: api }] }).compileComponents();
    fixture = TestBed.createComponent(SettingsComponent);
    component = fixture.componentInstance;
  });
  afterEach(() => fixture.destroy());

  it('ignores stale folder responses when switching workspaces', () => {
    const stale = new Subject<{ entries: never[]; page: number; page_size: number; has_more: boolean }>();
    api.listFiles.and.callFake(id => id === 1 ? stale : of({ entries: [], page: 1, page_size: 50, has_more: false }));
    component.selectWorkspace(workspace(1));
    component.selectWorkspace(workspace(2));
    stale.next({ entries: [], page: 8, page_size: 50, has_more: true });
    expect(component.selectedWorkspace?.id).toBe(2);
    expect(component.fileHasMore).toBeFalse();
  });

  it('ignores an earlier file preview that completes after the selected file', () => {
    const stale = new Subject<FileRead>();
    api.readFile.and.callFake((_id, path) => path === 'old.ts' ? stale : of(file(path)));
    component.selectWorkspace(workspace(1));
    component.openFile('old.ts');
    component.openFile('current.ts');
    stale.next(file('old.ts'));
    expect(component.selectedFile?.path).toBe('current.ts');
  });

  it('navigates to a parent folder and loads subsequent pages', () => {
    component.selectWorkspace(workspace(1));
    component.explorerPath = 'src/app';
    component.goUp();
    expect(component.explorerPath).toBe('src');
    expect(api.listFiles).toHaveBeenCalledWith(1, 'src', 1);
    component.loadExplorer(true);
    expect(api.listFiles).toHaveBeenCalledWith(1, 'src', 2);
  });

  it('requires an explicit non-empty workspace path', () => {
    component.workspacePath = '  ';
    component.registerWorkspace();
    expect(api.createWorkspace).not.toHaveBeenCalled();
  });

  it('does not let an old workspace list erase a newly registered folder', () => {
    const pending = new Subject<WorkspaceRead[]>();
    api.listWorkspaces.and.returnValue(pending);
    api.createWorkspace.and.returnValue(of(workspace(2)));
    component.loadWorkspaces();
    component.workspacePath = 'C:/Projects/2';
    component.registerWorkspace();
    pending.next([workspace(1)]);
    expect(component.workspaces.map(item => item.id)).toEqual([2]);
    expect(component.loadingWorkspaces).toBeFalse();
  });

  it('retains the latest Git status after an older refresh completes', () => {
    component.selectWorkspace(workspace(1));
    const pending = new Subject<GitStatusResponse>();
    api.getGitStatus.and.returnValues(pending, of({ is_git: true, status: [] }));
    component.loadGitStatus(); component.loadGitStatus();
    pending.next({ is_git: true, status: [{ path: 'old.ts', status: 'M' }] });
    expect(component.gitStatus?.status).toEqual([]);
  });
});

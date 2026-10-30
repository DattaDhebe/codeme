import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ModelCatalogComponent } from './model-catalog.component';
import { CodingModel, ModelCatalog } from './models';

const option: CodingModel = {
  id: 'small-coder', name: 'Small coding model', ollama_model: 'fixture-coder:7b',
  hugging_face_url: 'https://huggingface.co/example/coder', ollama_url: 'https://ollama.com/library/fixture-coder',
  license: 'Apache-2.0', download_size_gb: 4.7, memory_guidance: 'Allow extra memory for context.',
  tier: 'Lightweight', description: 'A local coding option.', validation_note: 'Evaluate it on your own project.',
  recommended: false, installed: false, active: false,
};
const catalog: ModelCatalog = { provider: 'ollama', download_supported: true, setup_active: false, inventory_available: true, researched_at: '2026-10-30', models: [option] };

describe('ModelCatalogComponent', () => {
  let fixture: ComponentFixture<ModelCatalogComponent>;
  let component: ModelCatalogComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [ModelCatalogComponent] }).compileComponents();
    fixture = TestBed.createComponent(ModelCatalogComponent);
    component = fixture.componentInstance;
    component.catalog = catalog;
  });

  it('requires an explicit choice and distinguishes download, installed, and unknown inventory', () => {
    const selected = spyOn(component.selectModel, 'emit');
    fixture.detectChanges();
    expect(selected).not.toHaveBeenCalled();
    expect(component.actionLabel(option)).toBe('Download and use');
    expect(component.actionLabel({ ...option, installed: true })).toBe('Use installed model');
    expect(component.actionLabel({ ...option, installed: null })).toBe('Check and set up');
    fixture.nativeElement.querySelector('article button').click();
    expect(selected).toHaveBeenCalledOnceWith(option);
  });

  it('prevents selecting another model during setup or generation', () => {
    const selected = spyOn(component.selectModel, 'emit');
    component.catalog = { ...catalog, setup_active: true };
    component.select(option);
    expect(component.canSelect(option)).toBeFalse();
    component.catalog = catalog;
    component.streaming = true;
    component.select(option);
    expect(selected).not.toHaveBeenCalled();
  });

  it('shows current chat selection without treating a different prepared model as in use', () => {
    component.status = { state: 'ready', provider: 'ollama', model: option.ollama_model, available_models: [option.ollama_model, 'other-local'], message: 'Ready', completed_bytes: 0, total_bytes: 0, percent: 100, error: null, can_retry: false, auto_setup_enabled: true };
    component.currentModel = 'other-local';
    expect(component.canSelect({ ...option, active: true, installed: true })).toBeTrue();
    component.currentModel = option.ollama_model;
    expect(component.actionLabel(option)).toBe('In use');
    expect(component.canSelect(option)).toBeFalse();
  });

  it('renders only trusted source links and explains memory and validation limits', () => {
    component.catalog = { ...catalog, models: [{ ...option, hugging_face_url: 'https://huggingface.co.evil.invalid/model', ollama_url: 'javascript:alert(1)' }] };
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('article a').length).toBe(0);
    expect(fixture.nativeElement.textContent).toContain('Weight size is approximate and is not total RAM');
    expect(fixture.nativeElement.textContent).toContain(option.validation_note);
    expect(component.sourceLink('https://user:secret@huggingface.co/model', 'huggingface.co')).toBeNull();
  });

  it('removes download actions when the actual provider differs from a stale Ollama catalog', () => {
    component.provider = 'openai_compatible';
    const selected = spyOn(component.selectModel, 'emit');
    component.select(option);
    fixture.detectChanges();
    expect(selected).not.toHaveBeenCalled();
    expect(fixture.nativeElement.querySelector('article button')).toBeNull();
    expect(fixture.nativeElement.textContent).toContain('Your local server manages model installation');
  });

  it('keeps a failed preference-save warning visible after model readiness', () => {
    component.status = { state: 'ready', provider: 'ollama', model: option.ollama_model, available_models: [option.ollama_model], message: 'Model ready for this session; selection could not be saved for restart.', completed_bytes: 0, total_bytes: 0, percent: 100, error: null, can_retry: false, auto_setup_enabled: true, explicit_selection: true, preference_saved: false };
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[role="alert"]').textContent).toContain('selection could not be saved for restart');
  });
});

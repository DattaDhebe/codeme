import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { ApiService } from './api.service';
import { RuntimeConfigService } from './runtime-config.service';

describe('ApiService model catalog', () => {
  let api: ApiService;
  let http: HttpTestingController;
  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting(), { provide: RuntimeConfigService, useValue: { apiBaseUrl: 'http://127.0.0.1:8000/api', defaultModel: 'local-model', isBrowser: true } }] });
    api = TestBed.inject(ApiService);
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());

  it('reads the catalog without starting setup or downloading', () => {
    api.getModelCatalog().subscribe();
    const request = http.expectOne('http://127.0.0.1:8000/api/model-catalog');
    expect(request.request.method).toBe('GET');
    request.flush({ models: [] });
  });

  it('posts only the selected catalog ID and preserves bodyless retries', () => {
    api.startModelSetup('small-coder').subscribe();
    const selected = http.expectOne('http://127.0.0.1:8000/api/model-setup');
    expect(selected.request.method).toBe('POST');
    expect(selected.request.body).toEqual({ catalog_id: 'small-coder' });
    selected.flush({ state: 'checking' });
    api.startModelSetup().subscribe();
    const retry = http.expectOne('http://127.0.0.1:8000/api/model-setup');
    expect(retry.request.body).toEqual({});
    retry.flush({ state: 'checking' });
  });
});

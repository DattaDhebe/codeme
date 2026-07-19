import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { PLATFORM_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { RuntimeConfigService } from './runtime-config.service';

describe('RuntimeConfigService', () => {
  let service: RuntimeConfigService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: PLATFORM_ID, useValue: 'browser' },
      ],
    });
    service = TestBed.inject(RuntimeConfigService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('loads one local runtime backend and default model', async () => {
    const loading = service.load();
    http.expectOne('/runtime-config.json').flush({ backendUrl: 'http://localhost:8123/', defaultModel: 'local-model' });
    await loading;
    expect(service.apiBaseUrl).toBe('http://localhost:8123/api');
    expect(service.defaultModel).toBe('local-model');
  });

  it('rejects remote endpoints unless explicitly allowed', async () => {
    const loading = service.load();
    http.expectOne('/runtime-config.json').flush({ backendUrl: 'https://example.com', allowRemoteBackend: false });
    await loading;
    expect(service.apiBaseUrl).toBe('http://127.0.0.1:8000/api');
  });
});

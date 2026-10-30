import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { fakeAsync, TestBed, tick } from '@angular/core/testing';
import { LOCAL_REQUEST_TIMEOUT_MS, localRequestTimeout } from './http-timeout.interceptor';

describe('bounded local HTTP requests', () => {
  let client: HttpClient;
  let http: HttpTestingController;
  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(withInterceptors([localRequestTimeout])), provideHttpClientTesting()] });
    client = TestBed.inject(HttpClient);
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());

  it('releases a setup request that never returns, even after its sent event', fakeAsync(() => {
    let failure: Error | null = null;
    client.get('/api/model-setup').subscribe({ error: error => failure = error });
    const request = http.expectOne('/api/model-setup');
    tick(LOCAL_REQUEST_TIMEOUT_MS);
    expect((failure as Error | null)?.name).toBe('TimeoutError');
    expect(request.cancelled).toBeTrue();
  }));

  it('bounds runtime bootstrap so the application can fall back and open', fakeAsync(() => {
    let failed = false;
    client.get('/runtime-config.json').subscribe({ error: () => failed = true });
    http.expectOne('/runtime-config.json');
    tick(LOCAL_REQUEST_TIMEOUT_MS);
    expect(failed).toBeTrue();
  }));
});

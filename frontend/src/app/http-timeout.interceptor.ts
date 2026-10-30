import { HttpInterceptorFn } from '@angular/common/http';
import { timeout } from 'rxjs';

export const LOCAL_REQUEST_TIMEOUT_MS = 15000;

// A stalled local daemon must not leave setup, navigation, or bootstrap locked.
export const localRequestTimeout: HttpInterceptorFn = (request, next) =>
  next(request).pipe(timeout({ each: /\/conversations\/\d+\/chat$/.test(request.url) ? 180000 : LOCAL_REQUEST_TIMEOUT_MS }));

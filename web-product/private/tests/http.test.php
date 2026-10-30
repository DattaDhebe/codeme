<?php
declare(strict_types=1);

// A temporary loopback server only. curl_exec is disabled in its process, so
// even an accidental valid create cannot make a provider/network request.
$count = 0;
function checkHttp(bool $ok, string $label): void
{ global $count; if (!$ok) throw new RuntimeException('FAIL: '.$label); ++$count; echo 'PASS '.$label.PHP_EOL; }
function removeHttpFixture(string $path): void
{
    foreach (new RecursiveIteratorIterator(new RecursiveDirectoryIterator($path, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::CHILD_FIRST) as $file) {
        if ($file->isDir() && !$file->isLink()) rmdir($file->getPathname()); else unlink($file->getPathname());
    }
    rmdir($path);
}
function requestHttp(int $port, string $path, string $method = 'GET', ?string $body = null, array $headers = []): array
{
    $all = [];
    foreach (array_replace(['Host' => 'www.dhebe.com', 'Connection' => 'close'], $headers) as $k => $v) $all[] = $k.': '.$v;
    $context = stream_context_create(['http' => ['method' => $method, 'header' => implode("\r\n", $all), 'content' => $body ?? '', 'ignore_errors' => true, 'timeout' => 5]]);
    $response = @file_get_contents('http://127.0.0.1:'.$port.$path, false, $context);
    $lines = $http_response_header ?? [];
    if ($response === false || !preg_match('~^HTTP/\S+ (\d+)~', $lines[0] ?? '', $match)) throw new RuntimeException('Loopback request failed');
    $map = [];
    foreach (array_slice($lines, 1) as $line) { $pair = explode(':', $line, 2); if (count($pair) === 2) $map[strtolower($pair[0])] = trim($pair[1]); }
    return [(int)$match[1], $response === '' ? null : json_decode($response, true, 32, JSON_THROW_ON_ERROR), $map];
}

$base = dirname(__DIR__, 3).'/.runtime/codeme-http-tests-'.bin2hex(random_bytes(8)); mkdir($base, 0700, true);
$public = $base.'/public_html'; $private = $base.'/codeme-payments-private'; $process = null;
try {
    mkdir($public.'/products/codeme/api', 0700, true); mkdir($private.'/lib', 0700, true); mkdir($private.'/releases');
    foreach (['bootstrap.php', 'lib/Commerce.php'] as $file) copy(dirname(__DIR__).'/'.$file, $private.'/'.$file);
    foreach (['_bootstrap.php', 'payments.php', 'download.php'] as $file) copy(dirname(__DIR__, 2).'/public/api/'.$file, $public.'/products/codeme/api/'.$file);
    $archive = "PK\x03\x04".str_repeat('HTTP-fixture', 20); file_put_contents($private.'/releases/test.zip', $archive);
    $source = $base.'/existing-private-connection.php';
    file_put_contents($source, '<?php return '.var_export(['enabled' => true, 'mode' => 'production', 'client_id' => 'fake_local_merchant', 'client_secret' => 'fake_local_secret_only',
        'origin' => 'https://resume.dhebe.com', 'runtime_dir' => '/must/not/be/imported', 'pricing' => ['amount' => 1]], true).';');
    $settings = ['connection_file' => $source, 'runtime_dir' => $private.'/runtime', 'archive_dir' => $private.'/releases', 'archive_path' => $private.'/releases/test.zip',
        'archive_sha256' => hash('sha256', $archive), 'archive_bytes' => strlen($archive), 'version' => '0.7.0', 'download_name' => 'CodeMe-0.7.0.zip'];
    $writeConfig = static function (array $settings) use ($private): void { file_put_contents($private.'/config.php', '<?php return '.var_export($settings, true).';'); };
    $writeConfig($settings);
    file_put_contents($base.'/router.php', '<?php $_SERVER["HTTPS"]="on"; $_SERVER["SERVER_PORT"]="443"; $path=parse_url($_SERVER["REQUEST_URI"],PHP_URL_PATH); $file=realpath($_SERVER["DOCUMENT_ROOT"].$path); if (!$file || !str_starts_with(str_replace("\\\\","/",$file),str_replace("\\\\","/",$_SERVER["DOCUMENT_ROOT"])."/") || pathinfo($file,PATHINFO_EXTENSION)!=="php") {http_response_code(404);return;} $_SERVER["SCRIPT_FILENAME"]=$file; require $file;');
    $socket = stream_socket_server('tcp://127.0.0.1:0', $errno, $error); if (!$socket) throw new RuntimeException('No loopback port');
    $address = stream_socket_get_name($socket, false); $port = (int)substr(strrchr($address, ':'), 1); fclose($socket);
    $command = [PHP_BINARY];
    if (!extension_loaded('curl')) {
        $binaryDir = dirname(PHP_BINARY); $dll = $binaryDir.'/ext/php_curl.dll';
        if (!is_file($dll)) throw new RuntimeException('HTTP readiness tests require PHP cURL (all gateway execution remains disabled).');
        $command = array_merge($command, ['-d', 'extension_dir='.$binaryDir.'/ext', '-d', 'extension=curl']);
    }
    // Config safety scenarios deliberately rewrite a PHP fixture between requests.
    // Disable opcode caching so that these changes are observed immediately.
    $command = array_merge($command, ['-d', 'opcache.enable=0', '-d', 'opcache.enable_cli=0', '-d', 'disable_functions=curl_exec', '-d', 'display_errors=0', '-S', '127.0.0.1:'.$port, '-t', $public, $base.'/router.php']);
    $process = proc_open($command, [['pipe', 'r'], ['file', $base.'/server-output.log', 'a'], ['file', $base.'/server-error.log', 'a']], $pipes);
    if (!is_resource($process)) throw new RuntimeException('Cannot start loopback PHP server'); fclose($pipes[0]);
    for ($attempt = 0; $attempt < 50; ++$attempt) { $probe = @fsockopen('127.0.0.1', $port); if ($probe) { fclose($probe); break; } usleep(50000); }
    [$status, $config, $headers] = requestHttp($port, '/products/codeme/api/payments.php?action=config');
    checkHttp($status === 200 && $config['enabled'] && $config['downloadReady'], 'private connection bridge and verified archive enable production config');
    checkHttp($config['amount'] === 499 && $config['amountPaise'] === 49900 && $config['product'] === 'codeme_download' && $config['currency'] === 'INR', 'Resume pricing and product never imported');
    checkHttp(!isset($config['client_id'], $config['client_secret'], $config['archive_path'], $config['runtime_dir']), 'config exposes no private connection or paths');
    checkHttp(str_contains($headers['cache-control'] ?? '', 'no-store') && ($headers['x-content-type-options'] ?? '') === 'nosniff', 'API responses private and nosniff');
    $cookieHeader = $headers['set-cookie'] ?? '';
    checkHttp(str_starts_with($cookieHeader, 'CODEMEPAYSESSION=') && str_contains(strtolower($cookieHeader), 'secure') && str_contains(strtolower($cookieHeader), 'httponly') && str_contains(strtolower($cookieHeader), 'samesite=lax') && str_contains($cookieHeader, 'path=/products/codeme/'), 'dedicated Secure HttpOnly same-site session cookie');
    $cookie = explode(';', $cookieHeader)[0];
    [, $same] = requestHttp($port, '/products/codeme/api/payments.php?action=config', 'GET', null, ['Cookie' => $cookie]);
    checkHttp($same['purchaseId'] === $config['purchaseId'] && $same['csrfToken'] === $config['csrfToken'], 'server-issued purchase persists in browser session');
    [, $other] = requestHttp($port, '/products/codeme/api/payments.php?action=config');
    checkHttp($other['purchaseId'] !== $config['purchaseId'] && $other['csrfToken'] !== $config['csrfToken'], 'another browser receives independent purchase identity');
    $postHeaders = ['Cookie' => $cookie, 'Content-Type' => 'application/json', 'Origin' => 'https://www.dhebe.com', 'X-CSRF-Token' => $config['csrfToken']];
    $body = json_encode(['purchaseId' => $config['purchaseId']], JSON_THROW_ON_ERROR);
    [$status, $reply] = requestHttp($port, '/products/codeme/api/payments.php?action=verify', 'POST', $body, $postHeaders);
    checkHttp($status === 200 && !$reply['paid'] && $reply['status'] === 'NOT_CREATED', 'empty session verification grants nothing and makes no provider request');
    $badHeaders = array_replace($postHeaders, ['X-CSRF-Token' => 'wrong']);
    [$status, $reply] = requestHttp($port, '/products/codeme/api/payments.php?action=verify', 'POST', $body, $badHeaders);
    checkHttp($status === 403 && $reply['error']['code'] === 'invalid_csrf', 'HTTP CSRF checked');
    [$status, $reply] = requestHttp($port, '/products/codeme/api/payments.php?action=verify', 'POST', json_encode(['purchaseId' => $other['purchaseId']]), $postHeaders);
    checkHttp($status === 403 && $reply['error']['code'] === 'purchase_mismatch', 'server-issued purchase ownership checked');
    [$status, $reply] = requestHttp($port, '/products/codeme/api/payments.php?action=verify', 'POST', '{bad', $postHeaders);
    checkHttp($status === 400 && $reply['error']['code'] === 'invalid_json', 'malformed JSON bounded and structured');
    [$status, $reply] = requestHttp($port, '/products/codeme/api/payments.php?action=verify', 'POST', $body, array_replace($postHeaders, ['Content-Type' => 'text/plain']));
    checkHttp($status === 415 && $reply['error']['code'] === 'json_required', 'JSON content type enforced');
    [$status, $reply] = requestHttp($port, '/products/codeme/api/payments.php?action=verify', 'POST', str_repeat('a', 4097), $postHeaders);
    checkHttp($status === 413 && $reply['error']['code'] === 'request_too_large', 'oversized request rejected');
    [$status, $reply] = requestHttp($port, '/products/codeme/api/payments.php?action=verify');
    checkHttp($status === 405 && $reply['error']['code'] === 'method_not_allowed', 'GET cannot verify or create payments');
    [$status, $reply] = requestHttp($port, '/products/codeme/api/download.php');
    checkHttp($status === 405, 'GET and payment redirects cannot download ZIP');
    [$status, $reply] = requestHttp($port, '/products/codeme/api/download.php', 'POST', $body, $postHeaders);
    checkHttp($status === 403 && $reply['error']['code'] === 'purchase_not_found', 'unpaid POST download cannot return an archive');
    [$status, $reply] = requestHttp($port, '/products/codeme/api/payments.php?action=config&paid=true');
    checkHttp($status === 400 && $reply['error']['code'] === 'invalid_request', 'query paid flag rejected');
    [$status, $reply] = requestHttp($port, '/products/codeme/api/payments.php?action=config', 'GET', null, ['Host' => 'resume.dhebe.com']);
    checkHttp($status === 403 && $reply['error']['code'] === 'invalid_host', 'foreign product host rejected at HTTP boundary');
    [$status, $reply] = requestHttp($port, '/products/codeme/api/payments.php?action=verify', 'POST', $body, array_replace($postHeaders, ['Origin' => 'https://evil.example']));
    checkHttp($status === 403 && $reply['error']['code'] === 'invalid_origin', 'foreign origin rejected at HTTP boundary');
    [$status] = requestHttp($port, '/products/codeme/api/_bootstrap.php');
    checkHttp($status === 404, 'direct discovery shim unavailable');
    file_put_contents($private.'/releases/test.zip', 'tampered');
    [, $disabled] = requestHttp($port, '/products/codeme/api/payments.php?action=config', 'GET', null, ['Cookie' => $cookie]);
    checkHttp(!$disabled['enabled'] && !$disabled['downloadReady'], 'changed package disables new checkout');
    [$status, $reply] = requestHttp($port, '/products/codeme/api/payments.php?action=create', 'POST', $body, $postHeaders);
    checkHttp($status === 503 && $reply['error']['code'] === 'payment_unavailable', 'missing package blocks new orders before gateway access');
    $writeConfig(array_replace($settings, ['connection_file' => $public.'/connection.php']));
    copy($source, $public.'/connection.php');
    [$status, $reply] = requestHttp($port, '/products/codeme/api/payments.php?action=config');
    checkHttp($status === 503 && $reply['error']['code'] === 'payment_unavailable', 'public connection config rejected');
    echo 'All '.$count.' loopback HTTP checks passed. Provider execution disabled.'.PHP_EOL;
} finally {
    if (is_resource($process)) { proc_terminate($process); proc_close($process); }
    removeHttpFixture($base);
}

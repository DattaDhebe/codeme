<?php
declare(strict_types=1);

namespace CodeMe\Payments;

// Resolve the implementation within this private tree before loading any PHP.
$root = realpath(__DIR__); $library = realpath(__DIR__.'/lib/Commerce.php');
if ($root === false || $library === false || !str_starts_with(str_replace('\\', '/', $library), rtrim(str_replace('\\', '/', $root), '/').'/') ||
    preg_match('~(?:^|/)public_html(?:/|$)~i', str_replace('\\', '/', $root))) throw new \RuntimeException('CodeMe payment service unavailable');
require_once $library;

function configuration(array $server): array
{
    $documentRoot = (string)($server['DOCUMENT_ROOT'] ?? '');
    if (!outsideDocumentRoot(__DIR__, $documentRoot)) throw unavailable();
    $file = __DIR__.'/config.php';
    if (!is_file($file) || !outsideDocumentRoot($file, $documentRoot)) throw unavailable();
    $private = require $file;
    if (!is_array($private) || array_diff(array_keys($private), ['connection_file', 'runtime_dir', 'archive_dir', 'archive_path', 'archive_sha256', 'archive_bytes', 'version', 'download_name'])) throw unavailable();
    $source = $private['connection_file'] ?? null; $connection = [];
    if (!is_string($source)) throw unavailable();
    if (is_file($source)) {
        if (!outsideDocumentRoot($source, $documentRoot)) throw unavailable();
        $sourceConfig = require $source;
        if (!is_array($sourceConfig)) throw unavailable();
        // No origin, pricing, runtime, cookie, session or entitlement is inherited.
        foreach (['enabled', 'mode', 'client_id', 'client_secret'] as $key) $connection[$key] = $sourceConfig[$key] ?? null;
        unset($sourceConfig);
    }
    $mode = $connection['mode'] ?? 'sandbox'; $id = $connection['client_id'] ?? ''; $secret = $connection['client_secret'] ?? '';
    if (!is_string($mode) || !in_array($mode, ['sandbox', 'production'], true) || !is_string($id) || !is_string($secret)) throw unavailable();
    $runtime = $private['runtime_dir'] ?? __DIR__.'/runtime';
    if (!is_string($runtime) || is_link($runtime) || !outsideDocumentRoot(is_dir($runtime) ? $runtime : dirname($runtime), $documentRoot)) throw unavailable();
    foreach (['archive_dir', 'archive_path', 'archive_sha256', 'version', 'download_name'] as $key) if (!is_string($private[$key] ?? null)) throw unavailable();
    if (!preg_match('/^[a-f0-9]{64}$/D', $private['archive_sha256']) || !is_int($private['archive_bytes'] ?? null) ||
        $private['archive_bytes'] < 22 || $private['archive_bytes'] > 104857600 || !preg_match('/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$/D', $private['version']) ||
        !preg_match('/^CodeMe-[a-zA-Z0-9.-]+\.zip$/D', $private['download_name'])) throw unavailable();
    $keysReady = strlen($id) >= 8 && strlen($secret) >= 8 && strlen($id) <= 512 && strlen($secret) <= 512 &&
        !preg_match('/[\r\n\x00]/', $id.$secret) && !preg_match('/REPLACE_WITH|CHANGEME|YOUR_SECRET/i', $id.$secret);
    $config = $private + ['document_root' => $documentRoot];
    $config['runtime_dir'] = $runtime; $config['mode'] = $mode; $config['client_id'] = $id; $config['client_secret'] = $secret;
    $config['configured'] = $keysReady && function_exists('curl_init');
    $config['download_ready'] = Archive::ready($config);
    $enabled = $connection['enabled'] ?? false;
    $config['enabled'] = in_array($enabled, [true, '1', 'true'], true) && $config['configured'] && $config['download_ready'] && $mode === 'production';
    return $config;
}

function sessionIdentity(array $config): array
{
    if (session_status() !== PHP_SESSION_NONE) throw unavailable();
    $directory = $config['runtime_dir'].'/sessions';
    if (is_link($directory) || (!is_dir($directory) && !@mkdir($directory, 0700, true) && !is_dir($directory)) || !outsideDocumentRoot($directory, $config['document_root'])) throw unavailable();
    @chmod($directory, 0700);
    ini_set('session.use_strict_mode', '1'); ini_set('session.use_only_cookies', '1'); ini_set('session.use_trans_sid', '0');
    ini_set('session.gc_maxlifetime', '2592000'); ini_set('session.cache_limiter', '');
    session_save_path($directory); session_name('CODEMEPAYSESSION');
    session_set_cookie_params(['lifetime' => 2592000, 'path' => '/products/codeme/', 'secure' => true, 'httponly' => true, 'samesite' => 'Lax']);
    if (!session_start()) throw unavailable();
    try {
        if (!is_string($_SESSION['owner'] ?? null) || !preg_match('/^[a-f0-9]{64}$/D', $_SESSION['owner']) ||
            !is_string($_SESSION['csrf'] ?? null) || !preg_match('/^[a-f0-9]{64}$/D', $_SESSION['csrf']) || !is_string($_SESSION['purchaseId'] ?? null)) {
            if (!session_regenerate_id(true)) throw unavailable();
            $_SESSION = ['owner' => bin2hex(random_bytes(32)), 'csrf' => bin2hex(random_bytes(32)), 'purchaseId' => uuid()];
        }
        purchaseId($_SESSION['purchaseId']);
        return ['owner' => $_SESSION['owner'], 'csrf' => $_SESSION['csrf'], 'purchaseId' => $_SESSION['purchaseId']];
    } finally { session_write_close(); }
}

function requestJson(): array
{
    $type = explode(';', (string)($_SERVER['CONTENT_TYPE'] ?? ''))[0];
    if (strtolower(trim($type)) !== 'application/json') throw new PaymentError(415, 'json_required', 'Send checkout details as JSON.');
    $length = $_SERVER['CONTENT_LENGTH'] ?? '';
    if ($length !== '' && (!ctype_digit((string)$length) || (int)$length > 4096)) throw new PaymentError(413, 'request_too_large', 'The checkout request is too large.');
    $raw = file_get_contents('php://input', false, null, 0, 4097);
    if ($raw === false || strlen($raw) > 4096) throw new PaymentError(413, 'request_too_large', 'The checkout request is too large.');
    try { $object = json_decode($raw, false, 16, JSON_THROW_ON_ERROR); }
    catch (\JsonException $error) { throw new PaymentError(400, 'invalid_json', 'The checkout request is not valid JSON.'); }
    if (!$object instanceof \stdClass) throw new PaymentError(400, 'invalid_request', 'Send one checkout object.');
    return (array)$object;
}

function sendJson(array $body, int $status = 200): void
{ http_response_code($status); header('Content-Type: application/json; charset=utf-8'); echo json_encode($body, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES); }

function run(string $endpoint): void
{
    ini_set('display_errors', '0');
    header('Cache-Control: no-store, private, max-age=0'); header('Pragma: no-cache');
    header('X-Content-Type-Options: nosniff'); header('X-Robots-Tag: noindex, nofollow');
    header("Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    try {
        if (!(strtolower((string)($_SERVER['HTTPS'] ?? '')) === 'on' || (string)($_SERVER['SERVER_PORT'] ?? '') === '443')) throw new PaymentError(403, 'https_required', 'Use the secure CodeMe checkout page.');
        assertRequestHost($_SERVER);
        if (!in_array($endpoint, ['payments', 'download'], true)) throw unavailable();
        if (array_diff(array_keys($_GET), $endpoint === 'payments' ? ['action'] : [])) throw new PaymentError(400, 'invalid_request', 'Unsupported checkout parameters.');
        $action = $endpoint === 'download' ? 'download' : ($_GET['action'] ?? 'config');
        if (!is_string($action) || !in_array($action, ['config', 'create', 'verify', 'download'], true) || ($endpoint === 'payments' && $action === 'download')) throw new PaymentError(404, 'unknown_action', 'This checkout action does not exist.');
        $method = $_SERVER['REQUEST_METHOD'] ?? '';
        if ($method !== ($action === 'config' ? 'GET' : 'POST')) {
            header('Allow: '.($action === 'config' ? 'GET' : 'POST'));
            throw new PaymentError(405, 'method_not_allowed', 'This request method is not supported.');
        }
        assertSameOrigin($_SERVER, $method === 'POST');
        $config = configuration($_SERVER); $identity = sessionIdentity($config);
        if ($action === 'config') {
            sendJson(['enabled' => $config['enabled'], 'mode' => $config['mode'], 'product' => PRODUCT, 'amount' => 499, 'amountPaise' => AMOUNT_PAISE,
                'currency' => CURRENCY, 'csrfToken' => $identity['csrf'], 'purchaseId' => $identity['purchaseId'], 'termsVersion' => TERMS_VERSION,
                'version' => $config['version'], 'downloadName' => $config['download_name'], 'sha256' => $config['archive_sha256'], 'downloadReady' => $config['download_ready']]);
            return;
        }
        if (!$config['configured'] || ($action === 'create' && !$config['enabled'])) throw unavailable();
        assertCsrf($identity['csrf'], $_SERVER['HTTP_X_CSRF_TOKEN'] ?? null); $body = requestJson();
        if (!is_string($body['purchaseId'] ?? null) || !hash_equals($identity['purchaseId'], $body['purchaseId'])) throw new PaymentError(403, 'purchase_mismatch', 'Refresh checkout to restore your purchase session.');
        $store = new FileStore($config['runtime_dir']);
        $store->rateLimit('owner|'.$action.'|'.$identity['owner'], $action === 'create' ? 20 : 60, $action === 'create' ? 3600 : 60);
        $store->rateLimit('address|'.$action.'|'.(string)($_SERVER['REMOTE_ADDR'] ?? ''), $action === 'create' ? 60 : 240, $action === 'create' ? 3600 : 60);
        $service = new CommerceService($store, new CashfreeGateway($config), $config);
        if ($action !== 'download') { sendJson($action === 'create' ? $service->create($identity['owner'], $body) : $service->verify($identity['owner'], $body)); return; }
        $file = $service->download($identity['owner'], $body);
        try {
            header('Content-Type: application/zip'); header('Content-Disposition: attachment; filename="'.$config['download_name'].'"');
            header('Content-Length: '.(string)$config['archive_bytes']); header('X-CodeMe-SHA256: '.$config['archive_sha256']);
            header('Accept-Ranges: none');
            if (fpassthru($file) === false) error_log('CodeMe download stream failed');
        } finally { fclose($file); }
    } catch (PaymentError $error) {
        if (in_array($error->httpStatus, [409, 429], true)) header('Retry-After: 5');
        sendJson(['error' => ['code' => $error->errorCode, 'message' => $error->getMessage()]], $error->httpStatus);
    } catch (\Throwable $error) {
        error_log('CodeMe checkout request failed: internal_error');
        sendJson(['error' => ['code' => 'payment_unavailable', 'message' => 'Checkout is temporarily unavailable. Please try again later.']], 503);
    }
}

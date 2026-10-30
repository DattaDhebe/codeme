<?php
declare(strict_types=1);

if (realpath((string)($_SERVER['SCRIPT_FILENAME'] ?? '')) === __FILE__) { http_response_code(404); exit; }

function codemePaymentEndpoint(string $endpoint): void
{
    ini_set('display_errors', '0');
    try {
        $public = realpath((string)($_SERVER['DOCUMENT_ROOT'] ?? ''));
        if ($public === false) throw new RuntimeException('Unavailable');
        $normalized = str_replace('\\', '/', $public);
        $base = preg_match('~^(.*)/public_html(?:/.*)?$~i', $normalized, $matches) ? $matches[1] : dirname($public);
        $private = realpath($base.'/codeme-payments-private');
        if ($private === false) throw new RuntimeException('Unavailable');
        $bootstrap = realpath($private.'/bootstrap.php');
        if ($bootstrap === false || !is_file($bootstrap)) throw new RuntimeException('Unavailable');
        $privatePath = rtrim(str_replace('\\', '/', $private), '/'); $bootstrapPath = str_replace('\\', '/', $bootstrap); $publicPath = rtrim($normalized, '/');
        if (PHP_OS_FAMILY === 'Windows') { $privatePath = strtolower($privatePath); $bootstrapPath = strtolower($bootstrapPath); $publicPath = strtolower($publicPath); }
        foreach ([$privatePath, $bootstrapPath] as $path) {
            if (preg_match('~(?:^|/)public_html(?:/|$)~i', $path) || $path === $publicPath || str_starts_with($path, $publicPath.'/')) throw new RuntimeException('Unavailable');
        }
        if (!str_starts_with($bootstrapPath, $privatePath.'/')) throw new RuntimeException('Unavailable');
        require_once $bootstrap;
        \CodeMe\Payments\run($endpoint);
    } catch (Throwable $error) {
        header('Content-Type: application/json; charset=utf-8'); header('Cache-Control: no-store, private, max-age=0');
        header('X-Content-Type-Options: nosniff'); header('X-Robots-Tag: noindex, nofollow'); http_response_code(503);
        echo json_encode(['error' => ['code' => 'payment_unavailable', 'message' => 'Checkout is temporarily unavailable. Please try again later.']]);
    }
}

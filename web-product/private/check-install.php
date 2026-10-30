<?php
declare(strict_types=1);

// CLI only. Prints readiness booleans and public release metadata, never secrets or paths.
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
require_once __DIR__.'/bootstrap.php';
try {
    $documentRoot = $argv[1] ?? dirname(__DIR__).'/public_html';
    $config = \CodeMe\Payments\configuration(['DOCUMENT_ROOT' => $documentRoot]);
    $store = new \CodeMe\Payments\FileStore($config['runtime_dir']);
    echo json_encode(['privateInstall' => true, 'connectionReady' => $config['configured'], 'mode' => $config['mode'],
        'enabled' => $config['enabled'], 'downloadReady' => $config['download_ready'], 'product' => \CodeMe\Payments\PRODUCT,
        'amountPaise' => \CodeMe\Payments\AMOUNT_PAISE, 'currency' => \CodeMe\Payments\CURRENCY, 'version' => $config['version'],
        'sha256' => $config['archive_sha256'], 'archiveBytes' => $config['archive_bytes']], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES).PHP_EOL;
    exit($config['enabled'] ? 0 : 2);
} catch (Throwable $error) {
    echo json_encode(['privateInstall' => false, 'enabled' => false, 'error' => 'payment_unavailable']).PHP_EOL;
    exit(2);
}

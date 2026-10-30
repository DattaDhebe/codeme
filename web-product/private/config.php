<?php
declare(strict_types=1);

// This file contains locations and release metadata only, never merchant secrets.
// The bootstrap imports ONLY enabled/mode/client_id/client_secret from this private source.
return [
    'connection_file' => dirname(__DIR__).'/careerlift-payments-private/config.php',
    'runtime_dir' => __DIR__.'/runtime',
    'archive_dir' => __DIR__.'/releases',
    'archive_path' => __DIR__.'/releases/codeme-0.7.0-local-9587d0a573e2.zip',
    'archive_sha256' => '2a36319da9fbe3e5d03e9de0de43c01d1de01dfb678300a2544022dc71254b67',
    'archive_bytes' => 644172,
    'version' => '0.7.0',
    'download_name' => 'CodeMe-0.7.0.zip',
];

<?php
declare(strict_types=1);

// This file contains locations and release metadata only, never merchant secrets.
// The bootstrap imports ONLY enabled/mode/client_id/client_secret from this private source.
return [
    'connection_file' => dirname(__DIR__).'/careerlift-payments-private/config.php',
    'runtime_dir' => __DIR__.'/runtime',
    'archive_dir' => __DIR__.'/releases',
    'archive_path' => __DIR__.'/releases/codeme-0.7.0-local-c015749a7d93.zip',
    'archive_sha256' => '6f640c61bb3b83b578b0740525ebe65b5f677f80422edb47abd8a3af221d8639',
    'archive_bytes' => 638432,
    'version' => '0.7.0',
    'download_name' => 'CodeMe-0.7.0.zip',
];

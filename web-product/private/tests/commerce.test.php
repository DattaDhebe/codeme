<?php
declare(strict_types=1);

require_once dirname(__DIR__).'/lib/Commerce.php';

use CodeMe\Payments\{Archive, CashfreeGateway, CommerceService, FileStore, Gateway, PaymentError};
use function CodeMe\Payments\{assertCsrf, assertRequestHost, assertSameOrigin, outsideDocumentRoot, paise, uuid};

// Offline only: no CashfreeGateway is constructed and no network access is used.
if (($argv[1] ?? '') === '--lock-worker') {
    try { (new FileStore($argv[2]))->locked($argv[3], static fn() => null); echo 'unlocked'; }
    catch (PaymentError $e) { echo $e->errorCode; }
    exit;
}

final class FakeGateway implements Gateway
{
    public array $calls = [];
    public ?array $remote = null;
    public array $payments = [];
    public array $refunds = [];
    public bool $postTimeout = false;
    public bool $getUnavailable = false;
    public bool $missing = false;
    public bool $postRejected = false;
    public $beforePost = null;
    public function request(string $method, string $path, ?array $body = null, ?string $idempotencyKey = null): array
    {
        $this->calls[] = [$method, $path, $body, $idempotencyKey];
        if ($method === 'POST') {
            if ($this->beforePost !== null) ($this->beforePost)($body, $idempotencyKey);
            if ($this->postRejected) throw new PaymentError(400, 'checkout_rejected', 'Rejected');
            if ($this->postTimeout) throw new PaymentError(503, 'gateway_unavailable', 'Timeout');
            $this->remote = $body + ['order_status' => 'ACTIVE', 'payment_session_id' => 'session_fake_local_only_123'];
            $this->missing = false;
            return $this->remote;
        }
        if ($this->getUnavailable) throw new PaymentError(503, 'gateway_unavailable', 'Unavailable');
        if (str_ends_with($path, '/payments')) return $this->payments;
        if (str_ends_with($path, '/refunds')) return $this->refunds;
        if ($this->missing || $this->remote === null) throw new PaymentError(404, 'gateway_order_missing', 'Missing');
        return $this->remote;
    }
    public function paid(): void
    {
        $this->remote['order_status'] = 'PAID';
        $this->payments = [['cf_payment_id' => 'fake_payment_123', 'order_id' => $this->remote['order_id'], 'payment_status' => 'SUCCESS',
            'payment_currency' => 'INR', 'payment_amount' => 499, 'is_captured' => true]];
        $this->refunds = [];
    }
}

$count = 0;
function check(bool $condition, string $label): void
{ global $count; if (!$condition) throw new RuntimeException('FAIL: '.$label); ++$count; echo 'PASS '.$label.PHP_EOL; }
function fails(callable $action, string $code, string $label): void
{
    try { $action(); }
    catch (PaymentError $e) { check($e->errorCode === $code, $label.' ('.$e->errorCode.')'); return; }
    throw new RuntimeException('FAIL: '.$label.' did not fail closed');
}
function fixture(string $base): array
{
    $dir = $base.'/case-'.bin2hex(random_bytes(5)); mkdir($dir, 0700, true); mkdir($dir.'/public_html'); mkdir($dir.'/releases');
    $zip = "PK\x03\x04".str_repeat('local-test-fixture', 16); file_put_contents($dir.'/releases/codeme.zip', $zip);
    $config = ['mode' => 'production', 'archive_path' => $dir.'/releases/codeme.zip', 'archive_dir' => $dir.'/releases',
        'archive_sha256' => hash('sha256', $zip), 'archive_bytes' => strlen($zip), 'document_root' => $dir.'/public_html'];
    $store = new FileStore($dir.'/runtime'); $gateway = new FakeGateway(); $owner = bin2hex(random_bytes(32)); $purchase = uuid();
    $body = ['purchaseId' => $purchase, 'customerPhone' => '9876543210', 'customerEmail' => 'buyer@example.test', 'acceptTerms' => true, 'termsVersion' => '2026-10-31'];
    return [$dir, $config, $store, $gateway, new CommerceService($store, $gateway, $config), $owner, $purchase, $body];
}
function removeFixture(string $path): void
{
    // Only the directory created by this process is ever passed here.
    foreach (new RecursiveIteratorIterator(new RecursiveDirectoryIterator($path, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::CHILD_FIRST) as $file) {
        if ($file->isDir() && !$file->isLink()) rmdir($file->getPathname()); else unlink($file->getPathname());
    }
    rmdir($path);
}

$base = dirname(__DIR__, 3).'/.runtime/codeme-commerce-tests-'.bin2hex(random_bytes(8)); mkdir($base, 0700, true);
try {
    [$dir, $config, $store, $gateway, $service, $owner, $purchase, $body] = fixture($base);
    check($service->verify($owner, ['purchaseId' => $purchase])['status'] === 'NOT_CREATED', 'unpaid session has no entitlement');
    fails(fn() => $service->create($owner, $body + ['amount' => 1]), 'invalid_request', 'client price rejected');
    fails(fn() => $service->create($owner, $body + ['product' => 'application_pack']), 'invalid_request', 'other product rejected');
    fails(fn() => $service->create($owner, array_replace($body, ['acceptTerms' => false])), 'terms_required', 'terms required');
    fails(fn() => $service->create($owner, array_replace($body, ['termsVersion' => 'old'])), 'terms_required', 'old terms rejected');
    fails(fn() => $service->create($owner, array_replace($body, ['customerPhone' => 'bad'])), 'invalid_phone', 'contact validated');
    $key = $store->key($owner, $purchase, 'production');
    $gateway->beforePost = static function (array $request, string $idempotency) use ($dir, $key): void {
        $record = json_decode(file_get_contents($dir.'/runtime/records/'.$key.'.json'), true, 32, JSON_THROW_ON_ERROR);
        check($record['orders'][0]['status'] === 'CREATING' && $record['orders'][0]['idempotencyKey'] === $idempotency && $record['orders'][0]['request'] === $request, 'durable intent saved before provider call');
        check($request['order_amount'] === 499 && $request['order_currency'] === 'INR' && $request['order_tags'] === ['codeme_product' => 'codeme_download', 'codeme_mode' => 'production'], 'server-fixed price and product');
        check($request['order_meta']['return_url'] === 'https://www.dhebe.com/products/codeme/?order_id={order_id}', 'return URL fixed by server');
    };
    $created = $service->create($owner, $body); $gateway->beforePost = null;
    check(!$created['paid'] && $created['status'] === 'ACTIVE' && str_starts_with($created['orderId'], 'codeme_'), 'create only returns a pending CodeMe order');
    $again = $service->create($owner, $body);
    check($again['orderId'] === $created['orderId'] && count(array_filter($gateway->calls, fn($c) => $c[0] === 'POST')) === 1, 'active checkout does not create another charge');
    $verifyBody = ['purchaseId' => $purchase, 'orderId' => $created['orderId']];
    check(!array_key_exists('paymentSessionId', $service->verify($owner, $verifyBody)), 'verification omits checkout session');
    fails(fn() => $service->download($owner, $verifyBody), 'payment_not_paid', 'ACTIVE order cannot download');
    fails(fn() => $service->verify(bin2hex(random_bytes(32)), $verifyBody), 'purchase_not_found', 'another session cannot verify purchase');
    fails(fn() => $service->verify($owner, array_replace($verifyBody, ['purchaseId' => uuid()])), 'purchase_not_found', 'another purchase cannot verify order');
    fails(fn() => $service->verify($owner, array_replace($verifyBody, ['orderId' => 'career_'.str_repeat('1', 32)])), 'invalid_order', 'Resume order prefix rejected');
    fails(fn() => $service->verify($owner, $verifyBody + ['paid' => true]), 'invalid_request', 'client paid flag rejected');
    $gateway->remote['order_status'] = 'EXPIRED';
    fails(fn() => $service->create($owner, $body), 'payment_pending', 'expired order blocks duplicate payment');
    $gateway->paid();
    check($service->verify($owner, $verifyBody)['paid'] === true, 'late-settled order freshly verified');
    $handle = $service->download($owner, $verifyBody); check(is_resource($handle) && hash('sha256', stream_get_contents($handle)) === $config['archive_sha256'], 'paid download streams exact verified private ZIP'); fclose($handle);
    $goodRemote = $gateway->remote;
    foreach ([['order_amount', 49], ['order_amount', '499.001'], ['order_currency', 'USD'], ['order_id', 'codeme_'.str_repeat('0', 32)]] as [$field, $value]) {
        $gateway->remote = array_replace($goodRemote, [$field => $value]);
        fails(fn() => $service->download($owner, $verifyBody), 'payment_mismatch', 'order '.$field.' mismatch blocked');
    }
    $gateway->remote = $goodRemote; $gateway->remote['order_tags']['codeme_product'] = 'application_pack';
    fails(fn() => $service->download($owner, $verifyBody), 'payment_mismatch', 'other product receipt blocked');
    $gateway->remote = $goodRemote; $gateway->remote['order_tags']['codeme_mode'] = 'sandbox';
    fails(fn() => $service->download($owner, $verifyBody), 'payment_mismatch', 'sandbox tag cannot unlock production');
    $gateway->remote = $goodRemote; $gateway->remote['customer_details']['customer_id'] = 'someone_else';
    fails(fn() => $service->download($owner, $verifyBody), 'payment_mismatch', 'customer mismatch blocked');
    $gateway->remote = $goodRemote;
    $goodPayment = $gateway->payments;
    foreach ([['payment_status', 'PENDING'], ['payment_currency', 'USD'], ['payment_amount', 49], ['order_id', 'foreign'], ['is_captured', false], ['cf_payment_id', 'bad/id']] as [$field, $value]) {
        $gateway->payments = [array_replace($goodPayment[0], [$field => $value])];
        fails(fn() => $service->download($owner, $verifyBody), 'payment_not_confirmed', 'payment '.$field.' mismatch blocked');
    }
    $gateway->payments = $goodPayment;
    foreach (['SUCCESS', 'PENDING', 'ONHOLD', 'UNKNOWN'] as $status) {
        $gateway->refunds = [['refund_id' => 'refund_test', 'order_id' => $created['orderId'], 'refund_currency' => 'INR', 'refund_amount' => 499, 'refund_status' => $status]];
        fails(fn() => $service->download($owner, $verifyBody), 'refund_unresolved', $status.' refund blocks cached paid entitlement');
    }
    $gateway->refunds[0]['refund_status'] = 'FAILED';
    check($service->verify($owner, $verifyBody)['paid'], 'well-formed failed refund permits payment proof');
    $gateway->refunds = [['refund_status' => 'FAILED']];
    fails(fn() => $service->download($owner, $verifyBody), 'refund_unresolved', 'malformed refund fails closed');
    $gateway->refunds = []; $gateway->getUnavailable = true;
    fails(fn() => $service->download($owner, $verifyBody), 'gateway_unavailable', 'provider outage does not trust cached PAID');
    $gateway->getUnavailable = false; $gateway->remote['order_status'] = 'ACTIVE';
    fails(fn() => $service->download($owner, $verifyBody), 'payment_not_paid', 'fresh remote status overrides stored PAID');
    $gateway->paid(); file_put_contents($config['archive_path'], "PK\x03\x04".str_repeat('tampered', 40));
    check(!Archive::ready($config), 'package checksum change disables readiness');
    fails(fn() => $service->download($owner, $verifyBody), 'payment_unavailable', 'tampered archive cannot download');
    check(!outsideDocumentRoot($dir.'/public_html', $dir.'/public_html'), 'document root never private');
    mkdir($dir.'/public_html/subdomain');
    check(!outsideDocumentRoot($dir.'/public_html/subdomain', $dir.'/public_html/subdomain'), 'nested public roots never private');
    file_put_contents($dir.'/public_html/leaked.zip', 'test');
    check(!Archive::ready(array_replace($config, ['archive_path' => $dir.'/public_html/leaked.zip', 'archive_dir' => $dir.'/public_html'])), 'archive in public_html rejected');
    check(paise('499.00') === 49900 && paise('499.001') === null && paise('4.99e2') === null && paise(true) === null, 'strict paise conversion rejects rounding and coercion');
    foreach ([[400, 'order_already_exists'], [400, 'request_invalid'], [422, 'idempotency_error'], [409, 'order_already_exists'], [400, 'customer_phone_invalid'], [422, 'unknown_error']] as [$httpStatus, $providerCode]) {
        fails(fn() => CashfreeGateway::decodeResponse('POST', $httpStatus, json_encode(['type' => 'invalid_request_error', 'code' => $providerCode, 'message' => 'untrusted provider text'])), 'gateway_unavailable', 'real gateway keeps POST '.$httpStatus.' '.$providerCode.' unresolved');
    }
    fails(fn() => CashfreeGateway::decodeResponse('POST', 400, 'not-json'), 'gateway_unavailable', 'non-JSON create error cannot become definite rejection');
    fails(fn() => CashfreeGateway::decodeResponse('GET', 404, '{}'), 'gateway_order_missing', 'real gateway read-only 404 remains a missing-order hint');
    fails(fn() => CashfreeGateway::decodeResponse('POST', 200, '{bad'), 'payment_unavailable', 'malformed success fails closed at real gateway boundary');
    check(CashfreeGateway::decodeResponse('GET', 200, '[]') === [], 'real gateway accepts a valid empty provider list');
    fails(fn() => assertCsrf(str_repeat('a', 64), str_repeat('b', 64)), 'invalid_csrf', 'CSRF mismatch rejected');
    fails(fn() => assertRequestHost(['HTTP_HOST' => 'resume.dhebe.com']), 'invalid_host', 'other product host rejected');
    fails(fn() => assertSameOrigin(['HTTP_ORIGIN' => 'https://evil.example'], true), 'invalid_origin', 'foreign origin rejected');
    fails(fn() => assertSameOrigin(['HTTP_SEC_FETCH_SITE' => 'cross-site', 'HTTP_ORIGIN' => 'https://www.dhebe.com'], true), 'invalid_origin', 'cross-site fetch rejected');
    fails(fn() => assertSameOrigin([], true), 'invalid_origin', 'POST without origin or referer rejected');
    assertSameOrigin(['HTTP_REFERER' => 'https://www.dhebe.com/products/codeme/'], true);
    check(true, 'same-origin referer accepted');

    // An uncertain create must retain exactly the same server-owned intent and key.
    [$dir2, $config2, $store2, $gateway2, $service2, $owner2, $purchase2, $body2] = fixture($base);
    $gateway2->postTimeout = true;
    fails(fn() => $service2->create($owner2, $body2), 'gateway_unavailable', 'ambiguous create fails without paid grant');
    $firstPost = $gateway2->calls[0]; $gateway2->missing = true; $gateway2->postTimeout = false;
    $verifyBody2 = ['purchaseId' => $purchase2, 'orderId' => $firstPost[2]['order_id']];
    $gateway2->getUnavailable = true;
    fails(fn() => $service2->verify($owner2, $verifyBody2), 'gateway_unavailable', 'ambiguous create does not mask provider outage as safe retry');
    $gateway2->getUnavailable = false;
    $resumable = $service2->verify($owner2, $verifyBody2);
    check(!$resumable['paid'] && $resumable['status'] === 'CREATING' && $resumable['orderId'] === $firstPost[2]['order_id'] && !isset($resumable['paymentSessionId']), 'missing ambiguous create returns scoped retry state without payment grant');
    check(count(array_filter($gateway2->calls, fn($c) => $c[0] === 'POST')) === 1, 'status check never automatically retries a create');
    fails(fn() => $service2->download($owner2, $verifyBody2), 'gateway_order_missing', 'resumable create cannot download');
    fails(fn() => $service2->verify(bin2hex(random_bytes(32)), $verifyBody2), 'purchase_not_found', 'resumable intent remains owner scoped');
    $retried = $service2->create($owner2, array_replace($body2, ['customerPhone' => '9988776655', 'customerEmail' => 'changed@example.test']));
    $posts = array_values(array_filter($gateway2->calls, fn($c) => $c[0] === 'POST'));
    check(count($posts) === 2 && $posts[0][2] === $posts[1][2] && $posts[0][3] === $posts[1][3] && $retried['orderId'] === $firstPost[2]['order_id'], 'retry uses original order payload and idempotency key');
    $gateway2->remote['order_status'] = 'TERMINATED';
    $replacement = $service2->create($owner2, $body2);
    check($replacement['orderId'] !== $retried['orderId'], 'authoritatively terminated order permits new checkout');

    [$dir3, $config3, $store3, $gateway3, $service3, $owner3, $purchase3, $body3] = fixture($base);
    $gateway3->postRejected = true;
    fails(fn() => $service3->create($owner3, $body3), 'checkout_rejected', 'definite provider create rejection recorded');
    $callsBefore = count($gateway3->calls);
    $rejected = $service3->verify($owner3, ['purchaseId' => $purchase3]);
    check(!$rejected['paid'] && $rejected['status'] === 'REJECTED' && count($gateway3->calls) === $callsBefore, 'definite rejected intent remains recoverable without missing-provider lookup');
    $gateway3->postRejected = false;
    $afterReject = $service3->create($owner3, $body3);
    check($afterReject['status'] === 'ACTIVE' && $afterReject['orderId'] !== $rejected['orderId'], 'explicit retry after definite rejection starts a new valid checkout');

    // Actual child process contends for the same stable flock file.
    $lockKey = $store2->key($owner2, $purchase2, 'production');
    $store2->locked($lockKey, function () use ($dir2, $lockKey): void {
        $pipes = []; $process = proc_open([PHP_BINARY, __FILE__, '--lock-worker', $dir2.'/runtime', $lockKey], [['pipe', 'r'], ['pipe', 'w'], ['pipe', 'w']], $pipes);
        if (!is_resource($process)) throw new RuntimeException('Cannot start lock worker');
        fclose($pipes[0]); $out = stream_get_contents($pipes[1]); $err = stream_get_contents($pipes[2]); fclose($pipes[1]); fclose($pipes[2]);
        check(proc_close($process) === 0 && $out === 'payment_in_progress' && $err === '', 'concurrent checkout receives 409 instead of second mutation');
    });
    $store2->locked($lockKey, static fn() => check(true, 'stable checkout lock released after operation'));
    $store2->rateLimit('test', 1, 60);
    fails(fn() => $store2->rateLimit('test', 1, 60), 'rate_limited', 'private rate limit enforced');
    echo 'All '.$count.' offline checks passed. No real provider calls.'.PHP_EOL;
} finally { removeFixture($base); }

<?php
declare(strict_types=1);

namespace CodeMe\Payments;

const PRODUCT = 'codeme_download';
const AMOUNT_PAISE = 49900;
const CURRENCY = 'INR';
const TERMS_VERSION = '2026-10-31';
const ORIGIN = 'https://www.dhebe.com';
const API_VERSION = '2025-01-01';

final class PaymentError extends \RuntimeException
{
    public function __construct(public int $httpStatus, public string $errorCode, string $message)
    { parent::__construct($message); }
}

function unavailable(): PaymentError
{ return new PaymentError(503, 'payment_unavailable', 'Checkout is temporarily unavailable. Please try again later.'); }

function uuid(): string
{
    $b = random_bytes(16); $b[6] = chr((ord($b[6]) & 15) | 64); $b[8] = chr((ord($b[8]) & 63) | 128);
    $h = bin2hex($b);
    return substr($h, 0, 8).'-'.substr($h, 8, 4).'-'.substr($h, 12, 4).'-'.substr($h, 16, 4).'-'.substr($h, 20);
}

function purchaseId(mixed $id): string
{
    if (!is_string($id) || !preg_match('/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/D', $id))
        throw new PaymentError(400, 'invalid_purchase', 'Refresh checkout to restore your purchase session.');
    return $id;
}

function orderId(mixed $id): string
{
    if (!is_string($id) || !preg_match('/^codeme_[a-f0-9]{32}$/D', $id))
        throw new PaymentError(400, 'invalid_order', 'This payment reference is not valid.');
    return $id;
}

function allowedKeys(array $body, array $allowed): void
{
    if (array_diff(array_keys($body), $allowed)) throw new PaymentError(400, 'invalid_request', 'Only supported checkout fields are accepted.');
}

/** Exact decimal comparison; never round provider amounts into an entitlement. */
function paise(mixed $amount): ?int
{
    if (!is_int($amount) && !is_float($amount) && !is_string($amount)) return null;
    $value = (string)$amount;
    if (!preg_match('/^(0|[1-9][0-9]{0,7})(?:\.([0-9]{1,2}))?$/D', $value, $parts)) return null;
    return (int)$parts[1] * 100 + (int)str_pad($parts[2] ?? '', 2, '0');
}

function assertCsrf(string $expected, mixed $provided): void
{
    if (!preg_match('/^[a-f0-9]{64}$/D', $expected) || !is_string($provided) || !hash_equals($expected, $provided))
        throw new PaymentError(403, 'invalid_csrf', 'Refresh this page before trying checkout again.');
}

function assertRequestHost(array $server): void
{
    if (!is_string($server['HTTP_HOST'] ?? null) || strtolower($server['HTTP_HOST']) !== 'www.dhebe.com')
        throw new PaymentError(403, 'invalid_host', 'Open checkout on www.dhebe.com.');
}

function assertSameOrigin(array $server, bool $post): void
{
    if (strtolower((string)($server['HTTP_SEC_FETCH_SITE'] ?? '')) === 'cross-site')
        throw new PaymentError(403, 'invalid_origin', 'Open checkout from the CodeMe product page.');
    $origin = $server['HTTP_ORIGIN'] ?? '';
    if ($origin !== '') {
        if (!is_string($origin) || !hash_equals(ORIGIN, $origin)) throw new PaymentError(403, 'invalid_origin', 'Open checkout from the CodeMe product page.');
    } elseif ($post) {
        $parts = parse_url((string)($server['HTTP_REFERER'] ?? ''));
        $ref = is_array($parts) && isset($parts['scheme'], $parts['host']) ? $parts['scheme'].'://'.$parts['host'].(isset($parts['port']) ? ':'.$parts['port'] : '') : '';
        if (!hash_equals(ORIGIN, $ref)) throw new PaymentError(403, 'invalid_origin', 'Open checkout from the CodeMe product page.');
    }
}

function outsideDocumentRoot(string $path, string $documentRoot): bool
{
    $real = realpath($path); $public = realpath($documentRoot);
    if ($real === false || $public === false) return false;
    $real = str_replace('\\', '/', $real); $public = rtrim(str_replace('\\', '/', $public), '/');
    if (preg_match('~(?:^|/)public_html(?:/|$)~i', $real)) return false;
    if (PHP_OS_FAMILY === 'Windows') { $real = strtolower($real); $public = strtolower($public); }
    return $real !== $public && !str_starts_with($real, $public.'/');
}

/** Private records and separate stable lock files survive ambiguous provider requests. */
final class FileStore
{
    public function __construct(private string $directory)
    {
        foreach (['', '/records', '/locks', '/rates'] as $suffix) {
            $path = $directory.$suffix;
            if (is_link($path) || (!is_dir($path) && !@mkdir($path, 0700, true) && !is_dir($path))) throw unavailable();
            @chmod($path, 0700);
        }
    }

    public function key(string $owner, string $purchase, string $mode): string
    {
        if (!preg_match('/^[a-f0-9]{64}$/D', $owner) || !in_array($mode, ['sandbox', 'production'], true)) throw unavailable();
        return hash('sha256', PRODUCT.'|'.$mode.'|'.$owner.'|'.purchaseId($purchase));
    }

    public function locked(string $key, callable $callback, string $bucket = 'records'): mixed
    {
        if (!preg_match('/^[a-f0-9]{64}$/D', $key) || !in_array($bucket, ['records', 'rates'], true)) throw unavailable();
        $lockPath = $this->directory.'/locks/'.$bucket.'-'.$key.'.lock';
        if (is_link($lockPath)) throw unavailable();
        $lock = @fopen($lockPath, 'c');
        if (!$lock) throw unavailable();
        @chmod($lockPath, 0600);
        try {
            $until = microtime(true) + 2;
            while (!flock($lock, LOCK_EX | LOCK_NB)) {
                if (microtime(true) >= $until) throw new PaymentError(409, 'payment_in_progress', 'A payment request is already running. Wait a moment and check its status.');
                usleep(25000);
            }
            $path = $this->directory.'/'.$bucket.'/'.$key.'.json';
            if (is_link($path)) throw unavailable();
            $record = [];
            if (is_file($path)) {
                if (filesize($path) > 262144) throw unavailable();
                $raw = @file_get_contents($path);
                if ($raw === false) throw unavailable();
                $record = json_decode($raw, true, 32, JSON_THROW_ON_ERROR);
                if (!is_array($record)) throw unavailable();
            }
            return $callback($record, function (array $record) use ($path): void { $this->write($path, $record); });
        } finally { flock($lock, LOCK_UN); fclose($lock); }
    }

    private function write(string $path, array $record): void
    {
        $json = json_encode($record, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES);
        if (strlen($json) > 262144) throw unavailable();
        $temp = @tempnam(dirname($path), '.write-');
        if (!$temp) throw unavailable();
        try {
            @chmod($temp, 0600); $handle = @fopen($temp, 'wb');
            if (!$handle) throw unavailable();
            try {
                $offset = 0;
                while ($offset < strlen($json)) {
                    $count = fwrite($handle, substr($json, $offset));
                    if ($count === false || $count === 0) throw unavailable();
                    $offset += $count;
                }
                if (!fflush($handle)) throw unavailable();
                if (function_exists('fsync') && !fsync($handle)) throw unavailable();
            } finally { fclose($handle); }
            if (!@rename($temp, $path)) throw unavailable();
            @chmod($path, 0600);
        } finally { if (is_file($temp)) @unlink($temp); }
    }

    public function rateLimit(string $scope, int $limit, int $seconds): void
    {
        $this->locked(hash('sha256', $scope), function (array $record, callable $save) use ($limit, $seconds): void {
            $now = time(); $events = array_values(array_filter($record['events'] ?? [], static fn($v) => is_int($v) && $v > $now - $seconds));
            if (count($events) >= $limit) throw new PaymentError(429, 'rate_limited', 'Too many checkout requests. Wait a little before trying again.');
            $events[] = $now; $save(['events' => $events]);
        }, 'rates');
    }
}

interface Gateway
{ public function request(string $method, string $path, ?array $body = null, ?string $idempotencyKey = null): array; }

final class CashfreeGateway implements Gateway
{
    public function __construct(private array $config) {}
    public function request(string $method, string $path, ?array $body = null, ?string $idempotencyKey = null): array
    {
        if (!in_array($method, ['GET', 'POST'], true) || !preg_match('~^/orders(?:/codeme_[a-f0-9]{32}(?:/(?:payments|refunds))?)?$~D', $path)) throw unavailable();
        $base = $this->config['mode'] === 'production' ? 'https://api.cashfree.com/pg' : 'https://sandbox.cashfree.com/pg';
        $headers = ['Accept: application/json', 'Content-Type: application/json', 'x-api-version: '.API_VERSION,
            'x-client-id: '.$this->config['client_id'], 'x-client-secret: '.$this->config['client_secret'], 'x-request-id: '.uuid()];
        if ($idempotencyKey !== null) $headers[] = 'x-idempotency-key: '.$idempotencyKey;
        $curl = curl_init($base.$path); if ($curl === false) throw unavailable();
        $response = ''; $tooLarge = false;
        try {
            curl_setopt_array($curl, [CURLOPT_CUSTOMREQUEST => $method, CURLOPT_HTTPHEADER => $headers,
                CURLOPT_CONNECTTIMEOUT => 5, CURLOPT_TIMEOUT => 20, CURLOPT_FOLLOWLOCATION => false,
                CURLOPT_PROTOCOLS => CURLPROTO_HTTPS, CURLOPT_SSL_VERIFYPEER => true, CURLOPT_SSL_VERIFYHOST => 2,
                CURLOPT_WRITEFUNCTION => static function ($handle, string $data) use (&$response, &$tooLarge): int {
                    if (strlen($response) + strlen($data) > 1048576) { $tooLarge = true; return 0; }
                    $response .= $data; return strlen($data);
                }]);
            if ($body !== null) curl_setopt($curl, CURLOPT_POSTFIELDS, json_encode($body, JSON_THROW_ON_ERROR));
            $ok = curl_exec($curl); $status = (int)curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
            if ($ok === false || $tooLarge) throw new PaymentError(503, 'gateway_unavailable', 'Payment status is temporarily unavailable. Check this same order again before paying.');
            return self::decodeResponse($method, $status, $response);
        } finally { curl_close($curl); }
    }

    /** @internal Shared HTTP boundary, directly exercised by offline gateway tests. */
    public static function decodeResponse(string $method, int $status, string $response): array
    {
        if (!in_array($method, ['GET', 'POST'], true) || strlen($response) > 1048576) throw unavailable();
        if ($method === 'GET' && $status === 404) throw new PaymentError(404, 'gateway_order_missing', 'This order is not yet available at the payment provider.');
        // A POST error status, including 400/422, does not prove that no order
        // exists: duplicate-order and idempotency conflicts may use these codes.
        // Preserve the original intent; a later read or idempotent retry resolves it.
        // Provider messages/codes are deliberately never treated as rejection proof.
        if ($status < 200 || $status > 299) throw new PaymentError(503, 'gateway_unavailable', 'Payment status is temporarily unavailable. Check this same order again before paying.');
        try { $decoded = json_decode($response, true, 32, JSON_THROW_ON_ERROR); }
        catch (\JsonException $error) { throw unavailable(); }
        if (!is_array($decoded)) throw unavailable();
        return $decoded;
    }
}

/** Opens and verifies the same private file handle that is streamed to the customer. */
final class Archive
{
    public static function open(array $config)
    {
        $path = $config['archive_path'] ?? ''; $dir = $config['archive_dir'] ?? ''; $root = $config['document_root'] ?? '';
        if (!is_string($path) || !is_string($dir) || is_link($path) || is_link($dir) || !is_file($path) || !outsideDocumentRoot($path, $root) || !outsideDocumentRoot($dir, $root)) throw unavailable();
        $real = realpath($path); $realDir = realpath($dir);
        if ($real === false || $realDir === false || dirname($real) !== $realDir || !preg_match('/^[a-f0-9]{64}$/D', (string)($config['archive_sha256'] ?? ''))) throw unavailable();
        $handle = @fopen($real, 'rb'); if (!$handle) throw unavailable();
        try {
            if (!flock($handle, LOCK_SH)) throw unavailable();
            $stat = fstat($handle);
            if ($stat === false || ($stat['mode'] & 0170000) !== 0100000 || $stat['size'] < 22 || $stat['size'] > 104857600 || $stat['size'] !== ($config['archive_bytes'] ?? null)) throw unavailable();
            $signature = fread($handle, 4);
            if (!in_array($signature, ["PK\x03\x04", "PK\x05\x06"], true) || !rewind($handle)) throw unavailable();
            $hash = hash_init('sha256'); $read = hash_update_stream($hash, $handle);
            if ($read !== $stat['size'] || !hash_equals($config['archive_sha256'], hash_final($hash)) || !rewind($handle)) throw unavailable();
            return $handle;
        } catch (\Throwable $error) { fclose($handle); throw $error; }
    }

    public static function ready(array $config): bool
    {
        try { $file = self::open($config); fclose($file); return true; }
        catch (\Throwable $error) { return false; }
    }
}

final class CommerceService
{
    public function __construct(private FileStore $store, private Gateway $gateway, private array $config) {}

    private function scoped(string $owner, string $purchase, array $record): void
    {
        if ($record !== [] && (($record['ownerHash'] ?? '') !== hash('sha256', $owner) || ($record['purchaseId'] ?? '') !== $purchase || ($record['product'] ?? '') !== PRODUCT || ($record['mode'] ?? '') !== $this->config['mode'])) throw new PaymentError(403, 'purchase_mismatch', 'This purchase does not belong to your checkout session.');
    }

    private function input(array $body, bool $create): string
    {
        allowedKeys($body, $create ? ['purchaseId', 'customerPhone', 'customerEmail', 'acceptTerms', 'termsVersion'] : ['purchaseId', 'orderId']);
        return purchaseId($body['purchaseId'] ?? null);
    }

    private function publicStatus(?array $order, bool $paid = false, bool $session = false): array
    {
        $result = ['paid' => $paid, 'orderId' => $order['orderId'] ?? null, 'status' => $order['status'] ?? 'NOT_CREATED',
            'amount' => 499, 'amountPaise' => AMOUNT_PAISE, 'currency' => CURRENCY, 'product' => PRODUCT, 'mode' => $this->config['mode']];
        if ($session && !$paid && ($order['status'] ?? '') === 'ACTIVE') $result['paymentSessionId'] = $order['paymentSessionId'];
        return $result;
    }

    private function remote(array $order, array $remote): array
    {
        if (($order['amountPaise'] ?? null) !== AMOUNT_PAISE || ($order['mode'] ?? '') !== $this->config['mode'] || ($order['product'] ?? '') !== PRODUCT ||
            ($remote['order_id'] ?? '') !== orderId($order['orderId'] ?? null) || paise($remote['order_amount'] ?? null) !== AMOUNT_PAISE ||
            ($remote['order_currency'] ?? '') !== CURRENCY || ($remote['customer_details']['customer_id'] ?? '') !== ($order['customerId'] ?? null) ||
            ($remote['order_tags']['codeme_product'] ?? '') !== PRODUCT || ($remote['order_tags']['codeme_mode'] ?? '') !== $this->config['mode'])
            throw new PaymentError(403, 'payment_mismatch', 'The payment details could not be verified. Contact support with your payment reference.');
        $status = $remote['order_status'] ?? null;
        if (!in_array($status, ['ACTIVE', 'PAID', 'EXPIRED', 'TERMINATED', 'TERMINATION_REQUESTED'], true)) throw unavailable();
        $order['status'] = $status; $order['checkedAt'] = time();
        if ($status === 'ACTIVE') {
            $session = $remote['payment_session_id'] ?? null;
            if (!is_string($session) || strlen($session) < 8 || strlen($session) > 2048 || preg_match('/[\x00-\x20\x7f]/', $session)) throw unavailable();
            $order['paymentSessionId'] = $session;
        } else { unset($order['paymentSessionId']); }
        if ($status !== 'CREATING') unset($order['request']);
        return $order;
    }

    private function getOrder(array $order): array
    { return $this->remote($order, $this->gateway->request('GET', '/orders/'.orderId($order['orderId'] ?? null))); }

    private function provePaid(array $order): void
    {
        if (($order['status'] ?? '') !== 'PAID') throw new PaymentError(403, 'payment_not_paid', 'Your payment has not been confirmed yet. Check its status before paying again.');
        if ($this->config['mode'] !== 'production') throw new PaymentError(403, 'production_payment_required', 'A production payment is required for this download.');
        $id = orderId($order['orderId']);
        $payments = $this->gateway->request('GET', '/orders/'.$id.'/payments');
        if (!array_is_list($payments) || count($payments) > 100) throw unavailable();
        $success = false;
        foreach ($payments as $payment) {
            if (!is_array($payment)) throw unavailable();
            $paymentId = $payment['cf_payment_id'] ?? null;
            if (($payment['payment_status'] ?? '') === 'SUCCESS' && (is_string($paymentId) || is_int($paymentId)) && preg_match('/^[a-zA-Z0-9_-]{1,100}$/D', (string)$paymentId) &&
                ($payment['order_id'] ?? '') === $id && ($payment['payment_currency'] ?? '') === CURRENCY && paise($payment['payment_amount'] ?? null) === AMOUNT_PAISE &&
                (!array_key_exists('is_captured', $payment) || $payment['is_captured'] === true)) $success = true;
        }
        if (!$success) throw new PaymentError(403, 'payment_not_confirmed', 'A successful payment could not yet be confirmed. Check this order again shortly.');
        $refunds = $this->gateway->request('GET', '/orders/'.$id.'/refunds');
        if (!array_is_list($refunds) || count($refunds) > 100) throw unavailable();
        foreach ($refunds as $refund) {
            $amount = is_array($refund) ? paise($refund['refund_amount'] ?? null) : null;
            if (!is_array($refund) || !is_string($refund['refund_id'] ?? null) || !preg_match('/^[a-zA-Z0-9_-]{1,100}$/D', $refund['refund_id']) ||
                ($refund['order_id'] ?? '') !== $id || ($refund['refund_currency'] ?? '') !== CURRENCY || !in_array($refund['refund_status'] ?? '', ['FAILED', 'CANCELLED'], true) ||
                $amount === null || $amount <= 0 || $amount > AMOUNT_PAISE)
                throw new PaymentError(403, 'refund_unresolved', 'This payment has a refund or an unresolved refund status. Contact support with your payment reference.');
        }
    }

    public function create(string $owner, array $body): array
    {
        $purchase = $this->input($body, true);
        if (($body['acceptTerms'] ?? null) !== true || ($body['termsVersion'] ?? '') !== TERMS_VERSION) throw new PaymentError(400, 'terms_required', 'Review and accept the current purchase terms before paying.');
        $phone = $body['customerPhone'] ?? null; $email = $body['customerEmail'] ?? '';
        if (!is_string($phone) || strlen($phone) > 40) throw new PaymentError(400, 'invalid_phone', 'Enter a valid phone number with 10 to 15 digits.');
        $phone = preg_replace('/[\s-]+/', '', $phone);
        if (!preg_match('/^\+?[0-9]{10,15}$/D', $phone)) throw new PaymentError(400, 'invalid_phone', 'Enter a valid phone number with 10 to 15 digits.');
        if (!is_string($email) || strlen($email) > 254 || ($email !== '' && !filter_var($email, FILTER_VALIDATE_EMAIL))) throw new PaymentError(400, 'invalid_email', 'Enter a valid email address or leave it empty.');
        return $this->store->locked($this->store->key($owner, $purchase, $this->config['mode']), function (array $record, callable $save) use ($owner, $purchase, $phone, $email): array {
            $this->scoped($owner, $purchase, $record);
            if ($record === []) $record = ['version' => 1, 'ownerHash' => hash('sha256', $owner), 'purchaseId' => $purchase, 'product' => PRODUCT, 'mode' => $this->config['mode'], 'orders' => []];
            $orders = $record['orders']; $index = count($orders) - 1; $order = $index >= 0 ? $orders[$index] : null;
            if ($order !== null && ($order['status'] ?? '') !== 'REJECTED') {
                try { $order = $this->getOrder($order); }
                catch (PaymentError $error) {
                    if ($error->errorCode !== 'gateway_order_missing' || ($order['status'] ?? '') !== 'CREATING') throw $error;
                }
                $record['orders'][$index] = $order; $save($record);
                if ($order['status'] === 'PAID') { $this->provePaid($order); return $this->publicStatus($order, true); }
                if ($order['status'] === 'ACTIVE') return $this->publicStatus($order, false, true);
                if (!in_array($order['status'], ['CREATING', 'TERMINATED'], true)) throw new PaymentError(409, 'payment_pending', 'The earlier order may still settle. Check its status or contact support before starting another payment.');
            }
            if ($order === null || in_array($order['status'], ['REJECTED', 'TERMINATED'], true)) {
                if (count($record['orders']) >= 10) throw new PaymentError(429, 'checkout_limit', 'The checkout attempt limit was reached. Contact support.');
                $id = 'codeme_'.bin2hex(random_bytes(16)); $customer = 'codeme_'.substr(hash('sha256', $owner.'|'.$purchase), 0, 32);
                $details = ['customer_id' => $customer, 'customer_phone' => $phone]; if ($email !== '') $details['customer_email'] = $email;
                $order = ['orderId' => $id, 'customerId' => $customer, 'product' => PRODUCT, 'mode' => $this->config['mode'], 'amountPaise' => AMOUNT_PAISE, 'status' => 'CREATING',
                    'createdAt' => time(), 'termsVersion' => TERMS_VERSION, 'termsAcceptedAt' => time(), 'idempotencyKey' => uuid(),
                    'request' => ['order_id' => $id, 'order_amount' => 499, 'order_currency' => CURRENCY, 'customer_details' => $details,
                        'order_expiry_time' => gmdate('Y-m-d\TH:i:s\Z', time() + 3600), 'order_note' => 'CodeMe local coding agent download',
                        'order_tags' => ['codeme_product' => PRODUCT, 'codeme_mode' => $this->config['mode']],
                        'order_meta' => ['return_url' => ORIGIN.'/products/codeme/?order_id={order_id}']]];
                $record['orders'][] = $order; $index = count($record['orders']) - 1; $save($record);
            }
            if (!is_array($order['request'] ?? null) || !is_string($order['idempotencyKey'] ?? null)) throw unavailable();
            try { $order = $this->remote($order, $this->gateway->request('POST', '/orders', $order['request'], $order['idempotencyKey'])); }
            catch (PaymentError $error) {
                if ($error->errorCode === 'checkout_rejected') { $order['status'] = 'REJECTED'; unset($order['request']); $record['orders'][$index] = $order; $save($record); }
                throw $error;
            }
            $record['orders'][$index] = $order; $save($record);
            if ($order['status'] === 'PAID') $this->provePaid($order);
            return $this->publicStatus($order, $order['status'] === 'PAID', true);
        });
    }

    private function checked(string $owner, array $body, bool $download): mixed
    {
        $purchase = $this->input($body, false);
        $requested = isset($body['orderId']) ? orderId($body['orderId']) : null;
        return $this->store->locked($this->store->key($owner, $purchase, $this->config['mode']), function (array $record, callable $save) use ($owner, $purchase, $requested, $download): mixed {
            $this->scoped($owner, $purchase, $record); $orders = $record['orders'] ?? [];
            if ($orders === []) {
                if ($requested !== null || $download) throw new PaymentError(403, 'purchase_not_found', 'No matching purchase was found in this browser session. Contact support with your payment reference.');
                return $this->publicStatus(null);
            }
            $index = count($orders) - 1;
            if ($requested !== null) {
                $matches = array_keys(array_filter($orders, static fn($v) => ($v['orderId'] ?? null) === $requested));
                if (count($matches) !== 1) throw new PaymentError(403, 'purchase_mismatch', 'This order does not belong to your checkout session.');
                $index = $matches[0];
            }
            $order = $orders[$index];
            // A definite create rejection never created a provider order. Keep the
            // owner-scoped state visible so the browser can explicitly try again.
            if (!$download && ($order['status'] ?? '') === 'REJECTED') return $this->publicStatus($order);
            try { $order = $this->getOrder($order); }
            catch (PaymentError $error) {
                // A missing ambiguous create may be retried ONLY through create(),
                // which reuses its durable payload, order ID and idempotency key.
                // Provider outages and every download still fail closed.
                if (!$download && ($order['status'] ?? '') === 'CREATING' && $error->errorCode === 'gateway_order_missing') return $this->publicStatus($order);
                throw $error;
            }
            $record['orders'][$index] = $order; $save($record);
            if ($order['status'] === 'PAID') $this->provePaid($order);
            elseif ($download) throw new PaymentError(403, 'payment_not_paid', 'Your payment has not been confirmed yet. Check its status before paying again.');
            return $download ? Archive::open($this->config) : $this->publicStatus($order, $order['status'] === 'PAID');
        });
    }

    public function verify(string $owner, array $body): array { return $this->checked($owner, $body, false); }
    public function download(string $owner, array $body) { return $this->checked($owner, $body, true); }
}

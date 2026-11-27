"""阿里云、腾讯云短信与语音直连。

渠道类型仍为 sms / voice，具体厂商由 config.provider 决定；未配置或为 webhook 时
沿用原有“POST 到外部网关”的行为。
"""
import base64
import hashlib
import hmac
import json
import re
import time
import uuid
from datetime import datetime, timezone
from urllib.parse import quote

import requests

ALIYUN_SMS_HOST = 'https://dysmsapi.aliyuncs.com'
ALIYUN_VOICE_HOST = 'https://dyvmsapi.aliyuncs.com'
TENCENT_SMS_SERVICE = 'sms'
TENCENT_SMS_VERSION = '2021-01-11'
TENCENT_VOICE_SERVICE = 'vms'
TENCENT_VOICE_VERSION = '2020-09-02'

PROVIDER_ALIYUN = 'aliyun'
PROVIDER_TENCENT = 'tencent'
PROVIDER_HUAWEI = 'huawei'
PROVIDER_WEBHOOK = 'webhook'
HUAWEI_SMS_ENDPOINT = 'https://smsapi.cn-north-4.myhuaweicloud.com:443/sms/batchSendSms/v1'


def _text(value, default=''):
    if value is None:
        return default
    return str(value).strip()


def normalize_provider(value):
    normalized = _text(value or PROVIDER_WEBHOOK).lower()
    aliases = {
        'ali': PROVIDER_ALIYUN,
        'aliyun': PROVIDER_ALIYUN,
        'ali-cloud': PROVIDER_ALIYUN,
        'tencent': PROVIDER_TENCENT,
        'tencentcloud': PROVIDER_TENCENT,
        'qcloud': PROVIDER_TENCENT,
        'huawei': PROVIDER_HUAWEI,
        'huaweicloud': PROVIDER_HUAWEI,
        'webhook': PROVIDER_WEBHOOK,
        '': PROVIDER_WEBHOOK,
    }
    return aliases.get(normalized, normalized)


def normalize_phones(phones, provider):
    numbers = []
    for raw in phones or []:
        digits = re.sub(r'[^\d]', '', _text(raw))
        if not digits:
            continue
        if provider in {PROVIDER_TENCENT, PROVIDER_HUAWEI}:
            if _text(raw).startswith('+'):
                value = f'+{digits}'
            elif digits.startswith('86') and len(digits) >= 13:
                value = f'+{digits}'
            elif len(digits) == 11:
                value = f'+86{digits}'
            else:
                value = f'+{digits}'
        else:
            value = f'+{digits}' if _text(raw).startswith('+') else digits
        if value not in numbers:
            numbers.append(value)
    if not numbers:
        raise RuntimeError('没有可用手机号，请填写渠道手机号或接收人手机号。')
    return numbers


def _percent_encode(value):
    return quote(_text(value), safe='~')


def _aliyun_signed_query(params, access_key_secret):
    canonicalized = '&'.join(f'{_percent_encode(key)}={_percent_encode(value)}' for key, value in sorted(params.items()))
    string_to_sign = f'GET&%2F&{_percent_encode(canonicalized)}'
    digest = hmac.new(
        f'{access_key_secret}&'.encode('utf-8'),
        string_to_sign.encode('utf-8'),
        hashlib.sha1,
    ).digest()
    return f'{canonicalized}&Signature={_percent_encode(base64.b64encode(digest).decode("utf-8"))}'


def _aliyun_call(host, action, config, action_params, timeout):
    access_key_id = _text(config.get('access_key_id'))
    access_key_secret = _text(config.get('access_key_secret'))
    if not access_key_id or not access_key_secret:
        raise RuntimeError('阿里云渠道需要配置 AccessKey ID 和 AccessKey Secret。')
    params = {
        'Action': action,
        'Format': 'JSON',
        'Version': '2017-05-25',
        'AccessKeyId': access_key_id,
        'SignatureMethod': 'HMAC-SHA1',
        'SignatureVersion': '1.0',
        'SignatureNonce': uuid.uuid4().hex,
        'Timestamp': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'RegionId': _text(config.get('region_id')) or 'cn-hangzhou',
        **{key: value for key, value in action_params.items() if value not in (None, '')},
    }
    query = _aliyun_signed_query(params, access_key_secret)
    response = requests.get(f'{host}/?{query}', timeout=timeout)
    body_text = response.text[:1000]
    if response.status_code >= 400:
        raise RuntimeError(f'HTTP {response.status_code}: {body_text}')
    try:
        body = response.json()
    except ValueError:
        body = {}
    code = body.get('Code') if isinstance(body, dict) else None
    if code not in (None, 'OK'):
        raise RuntimeError(f"Code={code}: {body.get('Message') or body_text}")
    return body, body_text


def _aliyun_template_params(params):
    if isinstance(params, dict):
        return json.dumps(params, ensure_ascii=False) if params else ''
    if isinstance(params, list) and params:
        return json.dumps({str(index): value for index, value in enumerate(params)}, ensure_ascii=False)
    return ''


def _send_aliyun_sms(config, phones, params, timeout):
    sign_name = _text(config.get('sign_name'))
    template_code = _text(config.get('template_code'))
    if not sign_name or not template_code:
        raise RuntimeError('阿里云短信需要配置短信签名和模板 Code。')
    body, body_text = _aliyun_call(
        ALIYUN_SMS_HOST,
        'SendSms',
        config,
        {
            'PhoneNumbers': ','.join(phones),
            'SignName': sign_name,
            'TemplateCode': template_code,
            'TemplateParam': _aliyun_template_params(params),
        },
        timeout,
    )
    return {'provider': PROVIDER_ALIYUN, 'provider_label': '阿里云短信', 'recipient_count': len(phones), 'request_id': body.get('RequestId') or '', 'response': body_text}


def _send_aliyun_voice(config, phones, params, timeout):
    tts_code = _text(config.get('tts_code'))
    if not tts_code:
        raise RuntimeError('阿里云语音需要配置 TTS 模板 Code。')
    play_times = _int_in_range(config.get('play_times'), 1, 3, default=2)
    call_ids = []
    responses = []
    for phone in phones:
        body, body_text = _aliyun_call(
            ALIYUN_VOICE_HOST,
            'SingleCallByTts',
            config,
            {
                'CalledNumber': phone,
                'CalledShowNumber': _text(config.get('called_show_number')),
                'TtsCode': tts_code,
                'TtsParam': _aliyun_template_params(params),
                'PlayTimes': play_times,
            },
            timeout,
        )
        call_ids.append(body.get('CallId') or body.get('RequestId') or '')
        responses.append(body_text)
    return {'provider': PROVIDER_ALIYUN, 'provider_label': '阿里云语音', 'recipient_count': len(phones), 'request_id': ','.join(filter(None, call_ids)), 'response': ' | '.join(responses)}


def _sha256_hex(value):
    return hashlib.sha256(value.encode('utf-8')).hexdigest()


def _hmac_sha256(key, message):
    return hmac.new(key, message.encode('utf-8'), hashlib.sha256).digest()


def _tencent_request(service, action, version, config, payload, timeout):
    secret_id = _text(config.get('secret_id'))
    secret_key = _text(config.get('secret_key'))
    if not secret_id or not secret_key:
        raise RuntimeError('腾讯云渠道需要配置 SecretId 和 SecretKey。')
    host = f'{service}.tencentcloudapi.com'
    timestamp = int(time.time())
    date = datetime.fromtimestamp(timestamp, timezone.utc).strftime('%Y-%m-%d')
    body = json.dumps(payload, ensure_ascii=False, separators=(',', ':'))
    content_type = 'application/json; charset=utf-8'
    signed_headers = 'content-type;host'
    canonical_request = (
        f'POST\n/\n\ncontent-type:{content_type}\nhost:{host}\n\n'
        f'{signed_headers}\n{_sha256_hex(body)}'
    )
    credential_scope = f'{date}/{service}/tc3_request'
    string_to_sign = f'TC3-HMAC-SHA256\n{timestamp}\n{credential_scope}\n{_sha256_hex(canonical_request)}'
    secret_date = _hmac_sha256(f'TC3{secret_key}'.encode('utf-8'), date)
    secret_service = _hmac_sha256(secret_date, service)
    secret_signing = _hmac_sha256(secret_service, 'tc3_request')
    signature = hmac.new(secret_signing, string_to_sign.encode('utf-8'), hashlib.sha256).hexdigest()
    headers = {
        'Authorization': f'TC3-HMAC-SHA256 Credential={secret_id}/{credential_scope}, SignedHeaders={signed_headers}, Signature={signature}',
        'Content-Type': content_type,
        'Host': host,
        'X-TC-Action': action,
        'X-TC-Version': version,
        'X-TC-Timestamp': str(timestamp),
    }
    region = _text(config.get('region')) or 'ap-guangzhou'
    headers['X-TC-Region'] = region
    response = requests.post(f'https://{host}', data=body.encode('utf-8'), headers=headers, timeout=timeout)
    body_text = response.text[:1000]
    if response.status_code >= 400:
        raise RuntimeError(f'HTTP {response.status_code}: {body_text}')
    try:
        body_json = response.json()
    except ValueError:
        raise RuntimeError(f'腾讯云返回非 JSON 内容: {body_text}')
    result = body_json.get('Response') if isinstance(body_json, dict) else None
    if not isinstance(result, dict):
        raise RuntimeError(f'腾讯云响应缺少 Response: {body_text}')
    error = result.get('Error')
    if error:
        raise RuntimeError(f"{error.get('Code')}: {error.get('Message')}")
    return result, body_text


def _send_tencent_sms(config, phones, params, timeout):
    sdk_app_id = _text(config.get('sdk_app_id'))
    sign_name = _text(config.get('sign_name'))
    template_id = _text(config.get('template_id'))
    if not sdk_app_id or not sign_name or not template_id:
        raise RuntimeError('腾讯云短信需要配置 SdkAppId、签名内容和模板 ID。')
    result, body_text = _tencent_request(
        TENCENT_SMS_SERVICE,
        'SendSms',
        TENCENT_SMS_VERSION,
        config,
        {
            'PhoneNumberSet': phones,
            'SmsSdkAppId': sdk_app_id,
            'SignName': sign_name,
            'TemplateId': template_id,
            'TemplateParamSet': list(params) if isinstance(params, list) else list(params.values()) if isinstance(params, dict) else [],
        },
        timeout,
    )
    statuses = result.get('SendStatusSet') or []
    failures = [item for item in statuses if item.get('Code') not in (None, 'Ok', 'OK')]
    if failures:
        detail = '; '.join(f"{item.get('PhoneNumber')}: {item.get('Code')} {item.get('Message') or ''}".strip() for item in failures)
        raise RuntimeError(f'腾讯云短信发送失败: {detail}')
    if not statuses:
        raise RuntimeError(f'腾讯云短信未返回发送状态: {body_text}')
    return {'provider': PROVIDER_TENCENT, 'provider_label': '腾讯云短信', 'recipient_count': len(phones), 'request_id': result.get('RequestId') or '', 'response': body_text}


def _send_tencent_voice(config, phones, params, timeout):
    voice_sdk_app_id = _text(config.get('voice_sdk_app_id'))
    template_id = _text(config.get('voice_template_id'))
    if not voice_sdk_app_id or not template_id:
        raise RuntimeError('腾讯云语音需要配置 VoiceSdkAppid 和模板 ID。')
    play_times = _int_in_range(config.get('play_times'), 1, 3, default=2)
    call_ids = []
    responses = []
    for phone in phones:
        result, body_text = _tencent_request(
            TENCENT_VOICE_SERVICE,
            'SendTtsVoice',
            TENCENT_VOICE_VERSION,
            config,
            {
                'TemplateId': template_id,
                'TemplateParamSet': list(params) if isinstance(params, list) else list(params.values()) if isinstance(params, dict) else [],
                'CalledNumber': phone,
                'VoiceSdkAppid': voice_sdk_app_id,
                'PlayTimes': play_times,
            },
            timeout,
        )
        send_status = result.get('SendStatus')
        if not isinstance(send_status, dict) or not send_status.get('CallId'):
            raise RuntimeError(f'腾讯云语音未返回 CallId: {body_text}')
        call_ids.append(send_status.get('CallId'))
        responses.append(body_text)
    return {'provider': PROVIDER_TENCENT, 'provider_label': '腾讯云语音', 'recipient_count': len(phones), 'request_id': ','.join(filter(None, call_ids)), 'response': ' | '.join(responses)}


def _huawei_wsse_headers(app_key, app_secret):
    nonce = uuid.uuid4().hex
    created = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    digest = base64.b64encode(
        hashlib.sha256(f'{nonce}{created}{app_secret}'.encode('utf-8')).digest()
    ).decode('utf-8')
    return {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'WSSE realm="SDP",profile="UsernameToken",type="Appkey"',
        'X-WSSE': f'UsernameToken Username="{app_key}",PasswordDigest="{digest}",Nonce="{nonce}",Created="{created}"',
    }


def _send_huawei_sms(config, phones, params, timeout):
    app_key = _text(config.get('app_key'))
    app_secret = _text(config.get('app_secret'))
    sender = _text(config.get('sender'))
    template_id = _text(config.get('template_id'))
    if not app_key or not app_secret:
        raise RuntimeError('华为云短信需要配置 AppKey 和 AppSecret。')
    if not sender or not template_id:
        raise RuntimeError('华为云短信需要配置发送方号码和模板 ID。')
    param_values = list(params) if isinstance(params, list) else list(params.values()) if isinstance(params, dict) else []
    payload = {
        'from': sender,
        'to': ','.join(phones),
        'templateId': template_id,
    }
    if param_values:
        payload['templateParas'] = json.dumps(param_values, ensure_ascii=False)
    signature = _text(config.get('sign_name'))
    if signature:
        payload['signature'] = signature
    endpoint = _text(config.get('endpoint')) or HUAWEI_SMS_ENDPOINT
    response = requests.post(
        endpoint,
        data=payload,
        headers=_huawei_wsse_headers(app_key, app_secret),
        timeout=timeout,
    )
    body_text = response.text[:1000]
    if response.status_code >= 400:
        raise RuntimeError(f'HTTP {response.status_code}: {body_text}')
    try:
        body = response.json()
    except ValueError:
        raise RuntimeError(f'华为云返回非 JSON 内容: {body_text}')
    code = body.get('code') or body.get('Code')
    description = body.get('description') or body.get('Description') or ''
    if code != '000000':
        raise RuntimeError(f'code={code}: {description or body_text}')
    result = body.get('result') or []
    failures = [item for item in result if _text(item.get('status')) not in ('000000',)]
    if failures:
        detail = '; '.join(f"{item.get('originTo')}: {item.get('status')}".strip() for item in failures)
        raise RuntimeError(f'华为云短信发送失败: {detail}')
    request_id = _text((result[0] or {}).get('smsMsgId')) if result and isinstance(result[0], dict) else ''
    return {'provider': PROVIDER_HUAWEI, 'provider_label': '华为云短信', 'recipient_count': len(phones), 'request_id': request_id, 'response': body_text}


def _huawei_voice_auth_headers(app_key, app_secret):
    nonce = uuid.uuid4().hex
    created = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    digest = base64.b64encode(
        hmac.new(app_secret.encode('utf-8'), f'{nonce}{created}'.encode('utf-8'), digestmod=hashlib.sha256).digest()
    ).decode('utf-8')
    return {
        'Content-Type': 'application/json;charset=UTF-8',
        'Authorization': 'AKSK realm="SDP",profile="UsernameToken",type="Appkey"',
        'X-AKSK': f'UsernameToken Username="{app_key}",PasswordDigest="{digest}",Nonce="{nonce}",Created="{created}"',
    }


def _send_huawei_voice(config, phones, params, timeout):
    app_key = _text(config.get('app_key'))
    app_secret = _text(config.get('app_secret'))
    endpoint = _text(config.get('endpoint')).rstrip('/')
    template_id = _text(config.get('voice_template_id'))
    if not app_key or not app_secret:
        raise RuntimeError('华为云语音需要配置 AppKey 和 AppSecret。')
    if not endpoint:
        raise RuntimeError('华为云语音需要配置语音通话控制台的 APP 接入地址。')
    if not template_id:
        raise RuntimeError('华为云语音需要配置语音模板 ID。')
    param_values = list(params) if isinstance(params, list) else list(params.values()) if isinstance(params, dict) else []
    display_nbr = _text(config.get('display_nbr'))
    session_ids = []
    responses = []
    for phone in phones:
        payload = {
            'calleeNbr': phone,
            'playInfoList': [{
                'templateId': template_id,
                'templateParas': param_values,
                'collectInd': 0,
            }],
        }
        if display_nbr:
            payload['displayNbr'] = display_nbr
        response = requests.post(
            f'{endpoint}/rest/httpsessions/callnotify/v2.0',
            json=payload,
            headers=_huawei_voice_auth_headers(app_key, app_secret),
            timeout=timeout,
        )
        body_text = response.text[:1000]
        if response.status_code >= 400:
            raise RuntimeError(f'HTTP {response.status_code}: {body_text}')
        try:
            body = response.json()
        except ValueError:
            raise RuntimeError(f'华为云语音返回非 JSON 内容: {body_text}')
        result_code = _text(body.get('resultcode'))
        if result_code != '0':
            raise RuntimeError(f"resultcode={result_code}: {body.get('resultdesc') or body_text}")
        session_ids.append(_text(body.get('sessionId')))
        responses.append(body_text)
    return {'provider': PROVIDER_HUAWEI, 'provider_label': '华为云语音', 'recipient_count': len(phones), 'request_id': ','.join(filter(None, session_ids)), 'response': ' | '.join(responses)}


def _int_in_range(value, minimum, maximum, default):
    try:
        number = int(value)
    except (TypeError, ValueError):
        return default
    return min(max(number, minimum), maximum)


def send_sms(provider, config, phones, params, timeout=8):
    provider = normalize_provider(provider)
    numbers = normalize_phones(phones, provider)
    if provider == PROVIDER_ALIYUN:
        summary = _send_aliyun_sms(config, numbers, params, timeout)
    elif provider == PROVIDER_TENCENT:
        summary = _send_tencent_sms(config, numbers, params, timeout)
    elif provider == PROVIDER_HUAWEI:
        summary = _send_huawei_sms(config, numbers, params, timeout)
    else:
        raise RuntimeError(f'未知短信厂商: {provider}')
    return f"{summary['provider_label']}已提交 {summary['recipient_count']} 个号码", summary


def send_voice(provider, config, phones, params, timeout=8):
    provider = normalize_provider(provider)
    numbers = normalize_phones(phones, provider)
    if provider == PROVIDER_ALIYUN:
        summary = _send_aliyun_voice(config, numbers, params, timeout)
    elif provider == PROVIDER_TENCENT:
        summary = _send_tencent_voice(config, numbers, params, timeout)
    elif provider == PROVIDER_HUAWEI:
        summary = _send_huawei_voice(config, numbers, params, timeout)
    else:
        raise RuntimeError(f'未知语音厂商: {provider}')
    return f"{summary['provider_label']}已提交 {summary['recipient_count']} 个号码", summary
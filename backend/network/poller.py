"""网络采集调度循环：按设备独立间隔到期驱动，信号量限并发，定期清理过期样本。"""
import asyncio
import logging
from datetime import timedelta

from asgiref.sync import sync_to_async
from django.conf import settings
from django.db.models import Q
from django.utils import timezone

from .collector import collect_device_interfaces, collect_device_system
from .models import DeviceMetricSample, InterfaceMetricSample, NetworkDevice
from .snmp import SnmpError, target_from_device

logger = logging.getLogger(__name__)

DEFAULT_TICK_SECONDS = 5
DEFAULT_CONCURRENCY = 8
PRUNE_INTERVAL_SECONDS = 3600


def select_due_devices(now=None):
    """返回 [(device, system_due, interface_due)]；间隔字段以设备自身配置为准。"""
    now = now or timezone.now()
    devices = NetworkDevice.objects.filter(enabled=True).select_related('credential')
    due = []
    for device in devices:
        system_due = (
            device.last_system_poll_at is None
            or device.last_system_poll_at <= now - timedelta(seconds=device.system_interval)
        )
        interface_due = (
            device.last_interface_poll_at is None
            or device.last_interface_poll_at <= now - timedelta(seconds=device.interface_interval)
        )
        if system_due or interface_due:
            due.append((device, system_due, interface_due))
    return due


def prune_expired_samples(retention_days=None):
    days = retention_days or getattr(settings, 'NETWORK_METRIC_RETENTION_DAYS', 30)
    cutoff = timezone.now() - timedelta(days=days)
    interface_deleted, _ = InterfaceMetricSample.objects.filter(sampled_at__lt=cutoff).delete()
    device_deleted, _ = DeviceMetricSample.objects.filter(sampled_at__lt=cutoff).delete()
    if interface_deleted or device_deleted:
        logger.info('网络指标保留清理：接口样本 %s 条，设备样本 %s 条（保留 %s 天）', interface_deleted, device_deleted, days)
    return interface_deleted + device_deleted


async def _collect_one(device, system_due, interface_due, semaphore):
    async with semaphore:
        try:
            target = await sync_to_async(target_from_device, thread_sensitive=False)(device)
            if system_due:
                await collect_device_system(device, target)
            if interface_due:
                await collect_device_interfaces(device, target)
        except SnmpError as exc:
            logger.warning('设备 %s 接口采集失败: %s', device.name, exc)
            await sync_to_async(_mark_interface_error, thread_sensitive=False)(device.pk, str(exc))
        except Exception:
            logger.exception('设备 %s 采集异常', device.name)


def _mark_interface_error(device_id, error):
    NetworkDevice.objects.filter(pk=device_id).update(
        last_interface_poll_at=timezone.now(), last_error=error[:2000],
    )


async def run_poller_loop(tick_seconds=DEFAULT_TICK_SECONDS, concurrency=DEFAULT_CONCURRENCY, once=False):
    semaphore = asyncio.Semaphore(concurrency)
    last_prune = timezone.now()
    logger.info('网络采集器启动：tick=%ss concurrency=%s once=%s', tick_seconds, concurrency, once)
    while True:
        try:
            due = await sync_to_async(select_due_devices, thread_sensitive=False)()
            if due:
                await asyncio.gather(*(_collect_one(device, system_due, interface_due, semaphore)
                                       for device, system_due, interface_due in due))
            now = timezone.now()
            if (now - last_prune).total_seconds() >= PRUNE_INTERVAL_SECONDS:
                await sync_to_async(prune_expired_samples, thread_sensitive=False)()
                last_prune = now
        except Exception:
            logger.exception('网络采集循环异常')
        if once:
            return
        await asyncio.sleep(tick_seconds)
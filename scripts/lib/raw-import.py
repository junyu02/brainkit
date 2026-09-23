#!/usr/bin/env python3
"""Private raw archives: descriptor-relative I/O, retained bytes, no overwrite."""
import ctypes
import fcntl
import hashlib
import json
import os
import stat
import sys
import time
import uuid

LIMIT = 128 * 1024 * 1024
FLAGS = os.O_NOFOLLOW | os.O_NONBLOCK
libc = ctypes.CDLL(None, use_errno=True)
if sys.platform != 'darwin' or not hasattr(libc, 'renameatx_np'):
    raise RuntimeError('raw import requires macOS renameatx_np and Python 3')
rename_exclusive = libc.renameatx_np
rename_exclusive.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
rename_exclusive.restype = ctypes.c_int


def publish(fd, old, new, destination=None):
    destination = fd if destination is None else destination
    if rename_exclusive(fd, os.fsencode(old), destination, os.fsencode(new), 4):
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code))
    os.fsync(fd)
    if destination != fd:
        os.fsync(destination)


def directory(root, path, create=False):
    fd = os.dup(root)
    try:
        for part in path.split('/') if path else []:
            if part in ('', '.', '..') or '\\' in part or any(ord(c) < 32 for c in part):
                raise ValueError('invalid descriptor-relative path')
            if create:
                try:
                    os.mkdir(part, 0o700, dir_fd=fd)
                    os.fsync(fd)
                except FileExistsError:
                    pass
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | FLAGS, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise


def root_fd(path):
    if not os.path.isabs(path) or path != os.path.realpath(path):
        raise ValueError('root must be a physical absolute directory')
    slash = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        return directory(slash, path.lstrip('/'))
    finally:
        os.close(slash)


def parent(root, path, create=False):
    folder, name = os.path.split(path)
    if not name or name in ('.', '..') or '/' in name or '\\' in name:
        raise ValueError('invalid file name')
    return directory(root, folder, create), name


def regular(root, path, limit=LIMIT):
    fd, name = parent(root, path)
    try:
        file = os.open(name, os.O_RDONLY | FLAGS, dir_fd=fd)
    finally:
        os.close(fd)
    try:
        metadata = os.fstat(file)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1 or metadata.st_size > limit:
            raise ValueError('state/media must be a bounded single-link regular file')
        return file, metadata
    except BaseException:
        os.close(file)
        raise


def chunks(file, before, limit=LIMIT):
    total = 0
    while data := os.read(file, min(1024 * 1024, limit + 1 - total)):
        total += len(data)
        if total > limit:
            raise ValueError('input exceeds its byte limit')
        yield data
    after = os.fstat(file)
    if total != before.st_size or any(getattr(before, key) != getattr(after, key)
        for key in ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns', 'st_nlink')):
        raise ValueError('input changed while reading')


def content(root, path, limit=LIMIT):
    file, before = regular(root, path, limit)
    try:
        return b''.join(chunks(file, before, limit))
    finally:
        os.close(file)


def fingerprint(root, path):
    try:
        file, before = regular(root, path)
    except FileNotFoundError:
        return None
    try:
        digest = hashlib.sha256()
        for data in chunks(file, before):
            digest.update(data)
        return digest.hexdigest()
    finally:
        os.close(file)


def write_new(root, path, data, expected=None, temporary_folder=None):
    fd, name = parent(root, path, True)
    temporary_fd = directory(root, temporary_folder) if temporary_folder else os.dup(fd)
    temporary = name + '.' + str(uuid.uuid4()) + '.partial'
    try:
        out = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | FLAGS, 0o600, dir_fd=temporary_fd)
        digest = hashlib.sha256()
        try:
            for block in data:
                digest.update(block)
                view = memoryview(block)
                while view:
                    view = view[os.write(out, view):]
            if expected is not None and digest.hexdigest() != expected:
                raise ValueError('source SHA-256 changed')
            os.fsync(out)
        finally:
            os.close(out)
        publish(temporary_fd, temporary, name, fd)
    finally:
        # Failed partial files remain in their managed directory; never unlink a replacement.
        os.close(fd)
        os.close(temporary_fd)


def copy_new(root, path, source_root, source, expected, temporary_folder=None):
    file, before = regular(source_root, source)
    try:
        write_new(root, path, chunks(file, before), expected, temporary_folder)
    finally:
        os.close(file)


def check_state(root, path):
    try:
        file, _ = regular(root, path, 32 * 1024 * 1024)
        os.close(file)
    except FileNotFoundError:
        pass


def inventory(root, path):
    directories, files = set(), set()

    def scan(fd, prefix='', depth=0):
        if depth > 16 or len(directories) + len(files) >= 64:
            raise ValueError('folder exceeds 64 entries or 16 levels')
        directories.add(prefix)
        for name in os.listdir(fd):
            if ('\\' in name or any(ord(c) < 32 or ord(c) == 127 for c in name)
                or (name.startswith('.') and name != '.DS_Store')):
                raise ValueError('unsupported hidden or unsafe folder entry')
            metadata = os.stat(name, dir_fd=fd, follow_symlinks=False)
            relative = prefix + '/' + name if prefix else name
            if stat.S_ISDIR(metadata.st_mode):
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | FLAGS, dir_fd=fd)
                try:
                    scan(child, relative, depth + 1)
                finally:
                    os.close(child)
            elif stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1:
                files.add(relative)
            else:
                raise ValueError('folder contains linked or non-regular entries')
            if len(directories) + len(files) > 64:
                raise ValueError('folder exceeds 64 entries')

    fd = directory(root, path)
    try:
        scan(fd)
    finally:
        os.close(fd)
    return directories, files


def run(request):
    root, desktop = root_fd(request['vault']), root_fd(request['desktop'])
    state = directory(root, '00-系统/.index-cache')
    gate = lock = None
    plan = request['plan']
    entries = plan['files']
    target = os.path.relpath(request['target'], request['vault'])
    journal = 'raw/processed/brain-write/raw-import/' + plan['operation_id']
    ledger = '00-系统/logs/brain-write-ledger.jsonl'
    manifest = journal + '/manifest.json'
    try:
        def preflight(complete=False):
            for path in (ledger, '00-系统/.index-cache/brain-write.lock', '00-系统/.index-cache/brain-write.lock.takeover'):
                check_state(root, path)
            if request.get('folder'):
                expected_dirs = set(plan['directories'])
                expected_files = {os.path.relpath(entry['source_path'], request['source_root']) for entry in entries}
                source = os.path.relpath(request['source_root'], request['desktop'])
                if inventory(desktop, source) != (expected_dirs, expected_files):
                    raise ValueError('folder source tree changed after preview')
                try:
                    actual_dirs, actual_files = inventory(root, target)
                except FileNotFoundError:
                    if complete:
                        raise ValueError('completed folder is missing')
                else:
                    if not actual_dirs <= expected_dirs or not actual_files <= expected_files:
                        raise ValueError('folder target contains conflicting extra entries')
                    if complete and (actual_dirs, actual_files) != (expected_dirs, expected_files):
                        raise ValueError('completed folder tree is incomplete')
            if request['qma']:
                source = os.path.relpath(os.path.dirname(entries[0]['source_path']), request['desktop'])
                fd = directory(desktop, source)
                try:
                    if sorted(os.listdir(fd)) != ['info.json', 'mic.m4a', 'sys.m4a']:
                        raise ValueError('QMA source must still contain exactly three standard files')
                finally:
                    os.close(fd)
                try:
                    fd = directory(root, target)
                except FileNotFoundError:
                    pass
                else:
                    try:
                        if any(name not in ('info.json', 'mic.m4a', 'sys.m4a') for name in os.listdir(fd)):
                            raise ValueError('raw QMA extra-file conflict')
                    finally:
                        os.close(fd)
            for entry in entries:
                source = os.path.relpath(entry['source_path'], request['desktop'])
                destination = os.path.relpath(entry['target_path'], request['vault'])
                if fingerprint(desktop, source) != entry['sha256']:
                    raise ValueError('raw source changed after preflight')
                existing = fingerprint(root, destination)
                if complete and existing is None:
                    raise ValueError('completed raw target is missing')
                if existing is not None and existing != entry['sha256']:
                    raise ValueError('raw target content conflict')

        preflight()
        if request['dry_run']:
            return {**plan, 'status': 'dry-run', 'target_path': request['target']}
        gate = os.open('brain-write.lock.takeover', os.O_CREAT | os.O_RDWR | FLAGS, 0o600, dir_fd=state)
        held = os.fstat(gate)
        if not stat.S_ISREG(held.st_mode) or held.st_nlink != 1:
            raise ValueError('invalid writer takeover gate')
        deadline = time.monotonic() + request['wait_ms'] / 1000
        while True:
            try:
                fcntl.flock(gate, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise RuntimeError('writer lock busy')
                time.sleep(0.025)
        while True:
            try:
                lock = os.open('brain-write.lock', os.O_WRONLY | os.O_CREAT | os.O_EXCL | FLAGS, 0o600, dir_fd=state)
                os.write(lock, json.dumps({'pid': os.getpid(), 'startedAt': time.time()}).encode() + b'\n')
                os.fsync(lock)
                break
            except FileExistsError:
                old = json.loads(content(root, '00-系统/.index-cache/brain-write.lock', 64 * 1024))
                if type(old.get('pid')) is not int or old['pid'] <= 0:
                    raise ValueError('invalid writer lock PID')
                try:
                    os.kill(old['pid'], 0)
                except ProcessLookupError:
                    publish(state, 'brain-write.lock', 'brain-write.lock.stale.' + str(uuid.uuid4()))
                    continue
                except PermissionError:
                    pass
                if time.monotonic() >= deadline:
                    raise RuntimeError('writer lock busy')
                time.sleep(0.025)
        preflight()
        encoded = json.dumps(plan, ensure_ascii=False, separators=(',', ':')).encode() + b'\n'
        try:
            previous = json.loads(content(root, manifest, 64 * 1024))
        except FileNotFoundError:
            write_new(root, manifest, [encoded])
        else:
            if previous != plan:
                raise ValueError('raw manifest conflict')
        for index, entry in enumerate(entries):
            stage = journal + '/' + str(index) + '.payload'
            existing = fingerprint(root, stage)
            if existing is None:
                copy_new(root, stage, desktop, os.path.relpath(entry['source_path'], request['desktop']), entry['sha256'])
            elif existing != entry['sha256']:
                raise ValueError('raw staging conflict')
        preflight()
        if request.get('folder'):
            for folder in plan['directories']:
                fd = directory(root, target + '/' + folder if folder else target, True)
                os.close(fd)
        for index, entry in enumerate(entries):
            destination = os.path.relpath(entry['target_path'], request['vault'])
            if fingerprint(root, destination) is None:
                copy_new(root, destination, root, journal + '/' + str(index) + '.payload', entry['sha256'], journal)
        preflight(complete=True)
        try:
            records = [json.loads(line) for line in content(root, ledger, 32 * 1024 * 1024).splitlines() if line]
        except FileNotFoundError:
            records = []
        if not any(e.get('action') == plan['action'] and e.get('operation_id') == plan['operation_id'] and e.get('status') == 'ok' for e in records):
            fd, name = parent(root, ledger, True)
            try:
                out = os.open(name, os.O_WRONLY | os.O_APPEND | os.O_CREAT | FLAGS, 0o600, dir_fd=fd)
                try:
                    metadata = os.fstat(out)
                    if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
                        raise ValueError('ledger must be a single-link regular file')
                    record = {**plan, 'ts': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                        'source': request['actor'], 'actor': request['actor'], 'status': 'ok',
                        'target_path': request['target'], 'provenance': request['provenance'],
                        'trigger': 'user-request' if request['provenance'].split(';')[0] == 'user-request' else 'unknown'}
                    data = memoryview(json.dumps(record, ensure_ascii=False).encode() + b'\n')
                    while data:
                        data = data[os.write(out, data):]
                    os.fsync(out)
                finally:
                    os.close(out)
            finally:
                os.close(fd)
        preflight(complete=True)
        return {**plan, 'status': 'ok', 'target_path': request['target'], 'manifest_path': request['vault'] + '/' + manifest}
    finally:
        if lock is not None:
            current, owned = os.stat('brain-write.lock', dir_fd=state, follow_symlinks=False), os.fstat(lock)
            if (current.st_dev, current.st_ino) == (owned.st_dev, owned.st_ino):
                publish(state, 'brain-write.lock', 'brain-write.lock.released.' + str(uuid.uuid4()))
            os.close(lock)
        if gate is not None:
            os.close(gate)
        os.close(state)
        os.close(desktop)
        os.close(root)


if __name__ == '__main__':
    try:
        print(json.dumps(run(json.load(sys.stdin)), ensure_ascii=False))
    except Exception as error:
        print(json.dumps({'status': 'error', 'message': str(error)}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)

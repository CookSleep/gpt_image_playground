#!/usr/bin/env python3

import argparse
import base64
import gzip
import sys


def main() -> None:
    parser = argparse.ArgumentParser(description='解码 Base64 并 gzip 解压后打印结果')
    parser.add_argument('value', nargs='?', help='Base64 字符串；不传时从标准输入读取')
    args = parser.parse_args()

    encoded = args.value if args.value is not None else sys.stdin.read()
    encoded = encoded.strip()
    if ',' in encoded and encoded.lower().startswith('data:'):
        encoded = encoded.split(',', 1)[1]

    try:
        compressed = base64.b64decode(encoded, validate=True)
        result = gzip.decompress(compressed)
        sys.stdout.write(result.decode('utf-8'))
    except (ValueError, base64.binascii.Error, OSError, UnicodeDecodeError) as err:
        parser.error(f'解码或解压失败：{err}')


if __name__ == '__main__':
    main()

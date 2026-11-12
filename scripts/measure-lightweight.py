"""Compare shipped app payloads with the same Electron runtime; excludes dev assets."""
import argparse, json, zipfile
from pathlib import Path
parser = argparse.ArgumentParser()
parser.add_argument('baseline', type=Path)
parser.add_argument('output', type=Path)
args = parser.parse_args()
root = Path(__file__).resolve().parent.parent
runtime = root / 'node_modules/electron/dist'
args.output.mkdir(parents=True, exist_ok=True)
results = {}
for name, source in [('baseline', args.baseline), ('current', root)]:
    files = [(p, Path('resources/app') / p.relative_to(source)) for p in (source / 'src').rglob('*') if p.is_file()]
    files.append((source / 'package.json', Path('resources/app/package.json')))
    target = args.output / f'work-helper-{name}.zip'
    with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for p in runtime.rglob('*'):
            if p.is_file(): archive.write(p, p.relative_to(runtime))
        for p, dest in files: archive.write(p, dest)
    results[name] = {'payloadBytes': sum(p.stat().st_size for p, _ in files), 'runtimeBytes': sum(p.stat().st_size for p in runtime.rglob('*') if p.is_file()), 'zipBytes': target.stat().st_size}
(args.output / 'measurements.json').write_text(json.dumps(results, indent=2))
print(json.dumps(results, indent=2))

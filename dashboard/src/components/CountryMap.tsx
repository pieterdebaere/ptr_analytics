// Bklit choropleth of visitors per country (lazy-loaded: world-atlas is ~100 KB).
import { useMemo } from 'react';
import type { Feature, FeatureCollection, Geometry } from 'geojson';
import { feature } from 'topojson-client';
import type { GeometryCollection, Topology } from 'topojson-specification';
import world from 'world-atlas/countries-110m.json';
import type { BreakdownRow } from '@/api/types';
import { ChoroplethChart, ChoroplethFeatureComponent, ChoroplethTooltip, type ChoroplethFeatureProperties } from '@/components/charts/choropleth';
import { countryName } from '@/lib/countries';
import { formatNumber } from '@/lib/format';
import { isoCountry } from '@/lib/live';

/** Natural Earth (world-atlas 110m) names that differ from the CLDR English region names. */
const NAME_ALIASES: Record<string, string> = {
  'W. Sahara': 'EH',
  'United States of America': 'US',
  'Dem. Rep. Congo': 'CD',
  'Dominican Rep.': 'DO',
  'Falkland Is.': 'FK',
  'Fr. S. Antarctic Lands': 'TF',
  'Central African Rep.': 'CF',
  Congo: 'CG',
  'Eq. Guinea': 'GQ',
  Palestine: 'PS',
  Myanmar: 'MM',
  Turkey: 'TR',
  'Solomon Is.': 'SB',
  'N. Cyprus': 'CY',
  Somaliland: 'SO',
  'Bosnia and Herz.': 'BA',
  Macedonia: 'MK',
  'Trinidad and Tobago': 'TT',
  'S. Sudan': 'SS',
};

const norm = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');

let nameIndex: Map<string, string> | null = null;
function codeForName(name: string): string | null {
  if (NAME_ALIASES[name]) return NAME_ALIASES[name]!;
  if (!nameIndex) {
    nameIndex = new Map();
    let dn: Intl.DisplayNames | null = null;
    try {
      dn = new Intl.DisplayNames(['en'], { type: 'region' });
    } catch {
      dn = null;
    }
    if (dn) {
      for (let a = 65; a < 91; a++) {
        for (let b = 65; b < 91; b++) {
          const code = String.fromCharCode(a, b);
          try {
            const n = dn.of(code);
            if (n && n !== code) nameIndex.set(norm(n), code);
          } catch {
            /* not a region */
          }
        }
      }
    }
  }
  return nameIndex.get(norm(name)) ?? null;
}

type CountryProps = ChoroplethFeatureProperties & { code: string | null };

let collection: FeatureCollection<Geometry, CountryProps> | null = null;
function worldCollection(): FeatureCollection<Geometry, CountryProps> {
  if (collection) return collection;
  const topo = world as unknown as Topology<{ countries: GeometryCollection<{ name: string }> }>;
  const fc = feature(topo, topo.objects.countries) as unknown as FeatureCollection<Geometry, { name: string }>;
  const features = fc.features
    .filter((f) => f.properties?.name !== 'Antarctica')
    .map((f): Feature<Geometry, CountryProps> => {
      const code = codeForName(f.properties?.name ?? '');
      return { ...f, properties: { name: code ? countryName(code) : (f.properties?.name ?? ''), code } };
    });
  collection = { type: 'FeatureCollection', features };
  return collection;
}

const SCALE = ['var(--chart-scale-02)', 'var(--chart-scale-03)', 'var(--chart-scale-04)', 'var(--chart-scale-05)'];

export default function CountryMap({ rows }: { rows: readonly BreakdownRow[] }) {
  const data = useMemo(() => worldCollection(), []);
  const values = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) {
      const iso = isoCountry(r.value);
      if (iso) m.set(iso, (m.get(iso) ?? 0) + r.visitors);
    }
    return m;
  }, [rows]);
  const max = Math.max(1, ...values.values());
  const valueOf = (f: { properties?: ChoroplethFeatureProperties | null }) => {
    const code = f.properties?.code;
    return typeof code === 'string' ? values.get(code) : undefined;
  };

  return (
    <div className="px-1 pt-2">
      <ChoroplethChart data={data} aspectRatio="16 / 10" className="w-full" animationDuration={500}>
        <ChoroplethFeatureComponent
          stroke="var(--card)"
          strokeWidth={0.5}
          getFeatureColor={(f) => {
            const v = valueOf(f);
            if (!v) return 'var(--muted)';
            const i = Math.min(SCALE.length - 1, Math.floor((Math.sqrt(v) / Math.sqrt(max)) * SCALE.length));
            return SCALE[Math.max(0, i)]!;
          }}
        />
        <ChoroplethTooltip
          valueLabel="Visitors"
          formatValue={(v) => formatNumber(v)}
          getFeatureValue={(f) => valueOf(f) ?? 0}
        />
      </ChoroplethChart>
      <p className="px-2 pt-1 text-xs text-muted-foreground">Top countries of the selected period. Switch to the list to filter.</p>
    </div>
  );
}

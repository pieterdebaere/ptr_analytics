// CONTRACT STUB — the globe agent replaces the implementation; keep the exported API.
import type { ReactNode } from 'react';

/** Aggregated value per country (ISO 3166-1 alpha-2, upper case). */
export interface GlobeCountryValue {
  country: string;
  value: number;
}

/** A transient "live" ping (e.g. a new pageview) drawn as a pulse at the country. */
export interface GlobePing {
  /** unique id; a ping is animated once when it first appears */
  id: string;
  country: string;
}

export interface GlobeProps {
  /** Countries to shade (choropleth intensity) and to place markers on. */
  countries?: readonly GlobeCountryValue[];
  /** Live pings; pass the most recent ones, old ids are ignored after animating. */
  pings?: readonly GlobePing[];
  /** Slowly rotate when the user is not interacting (default true). */
  autoRotate?: boolean;
  /** Show the zoom in / zoom out / reset buttons (default true). */
  controls?: boolean;
  /** Label used in the tooltip, e.g. "visitors" (default "visitors"). */
  valueLabel?: string;
  /** Optional overlay rendered on top of the canvas (e.g. a live counter). */
  children?: ReactNode;
  className?: string;
}

export function Globe(props: GlobeProps) {
  return <div className={props.className} data-globe-stub="" />;
}

import { Minus, Plus, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { MAX_ZOOM, MIN_ZOOM } from './scales';

export interface GlobeControlsProps {
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onReset: () => void;
  className?: string;
}

const btn =
  'bg-background/70 text-muted-foreground shadow-xs backdrop-blur-md hover:text-foreground dark:bg-background/50';

/** Zoom in / out / reset buttons overlaid on the globe. */
export function GlobeControls({ zoom, onZoomIn, onZoomOut, onReset, className }: GlobeControlsProps) {
  return (
    <div
      className={cn('pointer-events-auto absolute right-3 bottom-3 z-10 flex flex-col gap-1', className)}
      role="group"
      aria-label="Globe controls"
    >
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        className={btn}
        aria-label="Zoom in"
        title="Zoom in"
        disabled={zoom >= MAX_ZOOM - 1e-3}
        onClick={onZoomIn}
      >
        <Plus />
      </Button>
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        className={btn}
        aria-label="Zoom out"
        title="Zoom out"
        disabled={zoom <= MIN_ZOOM + 1e-3}
        onClick={onZoomOut}
      >
        <Minus />
      </Button>
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        className={btn}
        aria-label="Reset view"
        title="Reset view"
        onClick={onReset}
      >
        <RotateCcw />
      </Button>
    </div>
  );
}

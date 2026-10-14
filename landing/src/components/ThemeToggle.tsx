import { Moon, Sun } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTheme } from '~/hooks/useTheme';

export function ThemeToggle() {
  const [theme, setTheme] = useTheme();
  const next = theme === 'dark' ? 'light' : 'dark';
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="size-9 text-muted-foreground hover:text-foreground"
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
      onClick={() => setTheme(next)}
    >
      {theme === 'dark' ? <Sun /> : <Moon />}
    </Button>
  );
}

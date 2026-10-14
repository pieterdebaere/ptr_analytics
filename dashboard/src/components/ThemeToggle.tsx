import { MonitorIcon, MoonIcon, SunIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { isThemePreference, useTheme } from '@/hooks/useTheme';

/** Light / dark / system switch (persists in localStorage `pa_theme`). */
export function ThemeToggle() {
  const { preference, resolved, setPreference } = useTheme();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="icon" aria-label={`Theme: ${preference}. Change theme`} title="Theme" />}
      >
        {resolved === 'dark' ? <MoonIcon aria-hidden="true" /> : <SunIcon aria-hidden="true" />}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-36">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Theme</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={preference}
            onValueChange={(v: unknown) => {
              if (isThemePreference(v)) setPreference(v);
            }}
          >
            <DropdownMenuRadioItem value="light">
              <SunIcon aria-hidden="true" />
              Light
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="dark">
              <MoonIcon aria-hidden="true" />
              Dark
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="system">
              <MonitorIcon aria-hidden="true" />
              System
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

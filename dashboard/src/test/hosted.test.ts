import { describe, expect, it } from 'vitest';
import { normalizePublicConfig, isPublicPath, roleLabel } from '../hooks/auth';
import { readToken } from '../components/AuthCard';
import { resolveTheme } from '../hooks/useTheme';

describe('public config', () => {
  it('normalises untrusted values', () => {
    expect(normalizePublicConfig(null).signupEnabled).toBe(false);
    const c = normalizePublicConfig({
      signupEnabled: true,
      billingEnabled: 'yes',
      freeSites: 2.5,
      pricePerSiteCents: -1,
      currency: 'USD',
      termsUrl: 'javascript:alert(1)',
      privacyUrl: 'https://example.com/privacy',
    });
    expect(c).toEqual({
      signupEnabled: true,
      billingEnabled: false,
      freeSites: 2,
      pricePerSiteCents: 100,
      currency: 'usd',
      termsUrl: null,
      privacyUrl: 'https://example.com/privacy',
    });
  });

  it('knows the public routes and role labels', () => {
    expect(isPublicPath('/signup')).toBe(true);
    expect(isPublicPath('/sites/x')).toBe(false);
    expect(roleLabel('member')).toBe('Member');
    expect(roleLabel('admin')).toBe('Admin');
    expect(roleLabel('viewer')).toBe('Viewer');
    expect(roleLabel('<x>')).toBe('User');
  });

  it('reads well-formed tokens only', () => {
    expect(readToken(new URLSearchParams('token=abc_DEF-123'))).toBe('abc_DEF-123');
    expect(readToken(new URLSearchParams('token=a%20b'))).toBeNull();
    expect(readToken(new URLSearchParams('token=<script>'))).toBeNull();
    expect(readToken(new URLSearchParams(''))).toBeNull();
    expect(readToken(new URLSearchParams(`token=${'a'.repeat(600)}`))).toBeNull();
  });

  it('resolves the theme preference', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });
});

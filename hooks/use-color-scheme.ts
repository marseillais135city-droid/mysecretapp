import { useTheme } from '@/context/ThemeContext';

export function useColorScheme() {
    const { isDark } = useTheme();
    return isDark ? 'dark' : 'light';
}

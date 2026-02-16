import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { createContext, useContext, useEffect, useState } from 'react';
import { useColorScheme } from 'react-native';
import { ColorsDark, ColorsLight } from '../components/GhostTheme';

type ThemeType = 'light' | 'dark' | 'system';

interface ThemeContextType {
    theme: ThemeType;
    setTheme: (theme: ThemeType) => void;
    colors: typeof ColorsLight;
    isDark: boolean;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export const ThemeProvider = ({ children }: { children: React.ReactNode }) => {
    const systemScheme = useColorScheme();
    const [theme, setThemeState] = useState<ThemeType>('light');
    const [isDark, setIsDark] = useState(systemScheme === 'dark');

    useEffect(() => {
        loadTheme();
    }, []);

    useEffect(() => {
        // Update isDark whenever theme or systemScheme changes
        if (theme === 'system') {
            setIsDark(systemScheme === 'dark');
        } else {
            setIsDark(theme === 'dark');
        }
    }, [theme, systemScheme]);

    const loadTheme = async () => {
        try {
            const storedTheme = await AsyncStorage.getItem('app_theme_preference');
            if (storedTheme === 'dark') {
                setThemeState('dark');
            } else {
                setThemeState('light');
            }
        } catch (e) {
            console.error("Failed to load theme", e);
        }
    };

    const setTheme = async (newTheme: ThemeType) => {
        setThemeState(newTheme);
        await AsyncStorage.setItem('app_theme_preference', newTheme);
    };

    const colors = isDark ? ColorsDark : ColorsLight;

    return (
        <ThemeContext.Provider value={{ theme, setTheme, colors, isDark }}>
            {children}
        </ThemeContext.Provider>
    );
};

export const useTheme = () => {
    const context = useContext(ThemeContext);
    if (!context) {
        throw new Error('useTheme must be used within a ThemeProvider');
    }
    return context;
};

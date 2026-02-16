import { StyleSheet } from 'react-native';

export const ColorsLight = {
    background: '#F2F2F7',
    surface: '#FFFFFF',
    primary: '#007AFF',
    secondary: '#34C759',
    text: '#000000',
    textSecondary: '#8E8E93',
    error: '#FF3B30',
    border: '#C6C6C8',
    bubbleMe: '#007AFF',
    bubbleThem: '#E5E5EA',
    bubbleTextMe: '#FFFFFF',
    bubbleTextThem: '#000000',
};

export const ColorsDark = {
    background: '#000000',
    surface: '#1C1C1E',
    primary: '#0A84FF',
    secondary: '#30D158',
    text: '#FFFFFF',
    textSecondary: '#8E8E93',
    error: '#FF453A',
    border: '#38383A',
    bubbleMe: '#0A84FF',
    bubbleThem: '#2C2C2E',
    bubbleTextMe: '#FFFFFF',
    bubbleTextThem: '#FFFFFF',
};

// Default export for backward compatibility (temporarily)
export const Colors = ColorsLight;

export const getGhostStyles = (colors: any) => StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: colors.background,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 20,
        paddingTop: 60,
        paddingBottom: 15,
        backgroundColor: colors.surface,
        borderBottomWidth: 1,
        borderBottomColor: colors.border,
    },
    headerTitle: {
        color: colors.text,
        fontSize: 28, // Large iOS-style title
        fontWeight: 'bold',
    },
    headerSubtitle: {
        color: colors.textSecondary,
        fontSize: 13,
    },
    card: {
        backgroundColor: colors.surface,
        paddingVertical: 12, // Reduced padding for list look
        paddingHorizontal: 20,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: colors.border,
        flexDirection: 'row',
        alignItems: 'center',
    },
    input: {
        backgroundColor: colors.background === '#000000' ? '#2C2C2E' : '#E5E5EA', // Dynamic input background
        color: colors.text,
        borderRadius: 20, // Pill shape
        paddingVertical: 10,
        paddingHorizontal: 15,
        fontSize: 16,
        flex: 1,
    },
    buttonPrimary: {
        backgroundColor: colors.primary,
        paddingVertical: 15,
        borderRadius: 12,
        alignItems: 'center',
        justifyContent: 'center',
        marginHorizontal: 20,
        marginVertical: 10,
    },
    buttonText: {
        color: '#FFFFFF',
        fontSize: 16,
        fontWeight: '600',
    },
    label: {
        color: colors.textSecondary,
        fontSize: 13,
        marginBottom: 5,
        marginLeft: 20, // Align with list content
        marginTop: 15,
        textTransform: 'uppercase',
    },
    avatarContainer: {
        width: 50,
        height: 50,
        borderRadius: 25,
        backgroundColor: colors.border,
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
    },
    avatarImage: {
        width: '100%',
        height: '100%',
    },
    contactName: {
        color: colors.text,
        fontSize: 17,
        fontWeight: '600',
        marginBottom: 2,
    },
    lastMessage: {
        color: colors.textSecondary,
        fontSize: 15,
    },
    fab: {
        position: 'absolute',
        bottom: 30, // Standard FAB position
        right: 20,
        width: 56,
        height: 56,
        borderRadius: 28,
        backgroundColor: colors.primary,
        justifyContent: 'center',
        alignItems: 'center',
        shadowColor: "#000",
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.3,
        shadowRadius: 4.65,
        elevation: 8,
    }
});

// Backward compatibility using Light theme
export const GhostStyles = getGhostStyles(ColorsLight);

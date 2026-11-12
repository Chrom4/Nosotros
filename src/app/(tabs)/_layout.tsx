import { Redirect, Tabs } from 'expo-router';
import React from 'react';
import { TabIcon } from '@/components/TabIcon';
import { useSessionUIStore } from '@/store';

export default function TabsLayout() {
  const authStatus = useSessionUIStore((s) => s.authStatus);
  const activeHouseholdId = useSessionUIStore((s) => s.activeHouseholdId);

  if (authStatus === 'UNAUTHENTICATED') {
    return <Redirect href="/(auth)/login" />;
  }

  if (authStatus === 'AUTHENTICATED' && !activeHouseholdId) {
    return <Redirect href="/(auth)/create-household" />;
  }

  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: '#0F172A' },
        headerTintColor: '#F8FAFC',
        tabBarStyle: {
          backgroundColor: '#1E293B',
          borderTopColor: '#334155',
          height: 60,
          paddingBottom: 6,
          paddingTop: 6,
        },
        tabBarLabelStyle: {
          fontSize: 9,
          fontWeight: '500',
        },
        tabBarActiveTintColor: '#818CF8',
        tabBarInactiveTintColor: '#94A3B8',
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Início',
          tabBarIcon: ({ color, size }) => (
            <TabIcon name="dashboard" color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="transactions"
        options={{
          title: 'Lançar',
          tabBarIcon: ({ color, size }) => (
            <TabIcon name="transactions" color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="accounts"
        options={{
          title: 'Contas',
          tabBarIcon: ({ color, size }) => (
            <TabIcon name="accounts" color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="cards"
        options={{
          title: 'Cartões',
          tabBarIcon: ({ color, size }) => (
            <TabIcon name="cards" color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="invoices"
        options={{
          title: 'Faturas',
          tabBarIcon: ({ color, size }) => (
            <TabIcon name="invoices" color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="recurring"
        options={{
          title: 'Recorrentes',
          tabBarIcon: ({ color, size }) => (
            <TabIcon name="recurring" color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="categories"
        options={{
          title: 'Categorias',
          tabBarIcon: ({ color, size }) => (
            <TabIcon name="categories" color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="settings/backup"
        options={{
          title: 'Backup',
          tabBarIcon: ({ color, size }) => (
            <TabIcon name="backup" color={color} size={size} />
          ),
        }}
      />
    </Tabs>
  );
}

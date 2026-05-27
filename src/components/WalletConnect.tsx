import React from 'react';
import { useTonConnectUI, useTonAddress, useTonWallet } from '@tonconnect/ui-react';

interface WalletConnectProps {
  language: 'en' | 'ru';
}

const WalletConnect: React.FC<WalletConnectProps> = ({ language }) => {
  const [tonConnectUI] = useTonConnectUI();
  const userAddress = useTonAddress();
  const wallet = useTonWallet();

  const isConnected = !!wallet;

  const shortAddress = userAddress
    ? `${userAddress.slice(0, 4)}...${userAddress.slice(-4)}`
    : null;

  const texts = {
    en: {
      connect: 'Connect TON Wallet',
      connected: `Connected: ${shortAddress}`,
      disconnect: 'Disconnect',
    },
    ru: {
      connect: 'Подключить TON-кошелёк',
      connected: `Подключён: ${shortAddress}`,
      disconnect: 'Отключить',
    },
  }[language];

  if (isConnected) {
    return (
      <div className="wallet-connect wallet-connect--connected">
        <div className="wallet-connect__info">
          <span className="wallet-connect__dot" />
          <span className="wallet-connect__address">{texts.connected}</span>
        </div>
        <button
          className="wallet-connect__btn wallet-connect__btn--disconnect"
          onClick={() => tonConnectUI.disconnect()}
          type="button"
        >
          {texts.disconnect}
        </button>
      </div>
    );
  }

  return (
    <div className="wallet-connect">
      <button
        className="wallet-connect__btn wallet-connect__btn--connect"
        onClick={() => tonConnectUI.openModal()}
        type="button"
      >
        {texts.connect}
      </button>
    </div>
  );
};

export default WalletConnect;

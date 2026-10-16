# Dooya Connector

Cette intégration pilote, depuis Gladys, les moteurs appairés à une passerelle
**Dooya Connector** : stores enrouleurs, volets roulants, stores vénitiens, bannes,
portails et rideaux. La même passerelle est vendue sous d'autres marques (Brel, Bloc
Blinds, Coulisse Motion, Smart Blinds…) : si vos moteurs sont appairés dans
l'application **Connector**, cette intégration leur parle.

Tout se passe **sur votre réseau local** : Gladys dialogue avec la passerelle sur le
port UDP 32100. Aucun compte cloud n'est utilisé et rien ne sort de chez vous.

## Avant de commencer

1. La passerelle est installée dans l'application **Connector** et vos moteurs y sont
   appairés. Donnez à chaque moteur son type dans l'application (store enrouleur,
   rideau, store vénitien…) : Gladys s'en sert pour choisir la bonne carte.
2. La passerelle a une **adresse IP fixe** : réservez-la dans votre box (bail DHCP
   statique). L'intégration la joint à cette adresse ; si elle change, Gladys perd la
   passerelle.
3. Gladys et la passerelle sont sur le **même réseau**.

### Récupérer la clé

La passerelle n'accepte que les ordres accompagnés de sa **clé**, de 16 caractères :

1. Ouvrez l'application **Connector**.
2. Allez dans **Paramètres** (ou **Moi**), puis **À propos**.
3. Touchez l'écran **cinq fois** rapidement : la clé s'affiche, par exemple
   `12ab345c-d67e-8f`.

Recopiez-la **exactement**, tirets compris : ils font partie des 16 caractères.

### Récupérer l'adresse IP

- dans l'application Connector, le détail de la passerelle affiche souvent son
  adresse IP ;
- sinon, dans la liste des appareils connectés à votre box ;
- ou appuyez sur **Chercher la passerelle** dans la configuration de l'intégration
  (voir plus bas).

## Configuration

| Champ                          | Ce qu'il faut saisir                                                                    |
| ------------------------------ | --------------------------------------------------------------------------------------- |
| Adresse IP de la passerelle    | L'adresse IPv4 de la passerelle, par exemple `192.168.1.50`.                            |
| Clé de l'application Connector | La clé de 16 caractères (voir plus haut). Jamais écrite dans les journaux.              |
| Intervalle de rafraîchissement | Fréquence de lecture de l'état de chaque moteur, de 30 à 3600 secondes (60 par défaut). |
| Seuil de batterie faible (%)   | Sous ce niveau, le déclencheur de scène `battery_low` se déclenche (20 % par défaut).   |

Enregistrez, puis appuyez sur **Tester la connexion** : la réponse donne l'adresse de la
passerelle, le nombre de moteurs, le firmware et le signal Wi-Fi, et confirme que la
clé est acceptée.

## Ajouter les moteurs

Ouvrez l'onglet **Découverte** de l'intégration : chaque moteur de la passerelle y
figure. Ajoutez ceux que vous voulez et renommez-les (la passerelle n'a pas de noms :
un moteur apparaît d'abord comme « Roller blind 0001 », les derniers chiffres de son
adresse).

### Ce que montre chaque moteur

| Fonctionnalité | Quand                         | Valeurs                      |
| -------------- | ----------------------------- | ---------------------------- |
| État           | toujours                      | ouvrir / stop / fermer       |
| Position       | le moteur remonte sa position | 0 % (fermé) à 100 % (ouvert) |
| Batterie       | moteur sur batterie           | 0 à 100 %                    |

Un store **jour/nuit à deux rails** (top down bottom up) a deux rails, donc deux états
et deux positions : « top » (haut) et « bottom » (bas).

Un moteur radio unidirectionnel ne fait que recevoir des ordres : il n'a pas de
position, et Gladys affiche le dernier ordre envoyé.

### Comment l'état reste à jour

La passerelle garde en mémoire le dernier état de chaque moteur. Gladys le lit à
l'**intervalle de rafraîchissement** : cela ne coûte ni trafic radio ni batterie. Après
un ordre de Gladys, le moteur est suivi **toutes les 2 secondes** jusqu'à son arrêt :
la position suit le mouvement.

Un moteur bougé par sa télécommande, l'application ou un interrupteur est vu à la
lecture suivante.

Le badge de chaque moteur indique **local** tant que la passerelle répond,
**injoignable** sinon.

## Actions

Dans la configuration de l'intégration :

- **Tester la connexion** : vérifie l'adresse et la clé, et résume ce que dit la
  passerelle.
- **Chercher la passerelle** : Gladys diffuse une demande de découverte sur votre
  réseau et liste les passerelles qui répondent, avec leur adresse IP. Certaines
  passerelles ne répondent qu'à leur propre groupe multicast et restent muettes : lisez
  alors l'adresse dans votre box.
- **Identifier un moteur** : le moteur choisi fait un petit pas vers le haut, puis
  revient. Pratique pour savoir quel store est lequel.

## Scènes (Gladys 5.1+)

### Déclencheurs de scène

| Déclencheur                           | Clé                      | Filtres           | Variables                              |
| ------------------------------------- | ------------------------ | ----------------- | -------------------------------------- |
| Un store a bougé sans Gladys          | `moved_outside_gladys`   | moteur, sens      | `device_name`, `direction`, `position` |
| La batterie d'un moteur est faible    | `battery_low`            | moteur            | `device_name`, `battery`               |
| La connexion à la passerelle a changé | `hub_connection_changed` | perdue / rétablie | `status`                               |

- `moved_outside_gladys` se déclenche quand un moteur s'arrête à une nouvelle position
  après une télécommande, l'application Connector ou un interrupteur. Un mouvement
  ordonné par Gladys ne le déclenche jamais (pendant 2 minutes après l'ordre) : une
  scène ne peut pas boucler.
- `battery_low` se déclenche une fois quand la batterie passe sous le seuil, puis de
  nouveau seulement après une recharge.
- `hub_connection_changed` se déclenche quand la passerelle ne répond plus (`lost`) et
  quand elle répond de nouveau (`restored`).

Utilisez les variables dans les actions suivantes, par exemple
`{{triggerEvent.data.device_name}}`.

### Actions de scène

| Action                       | Clé                 | Paramètres                |
| ---------------------------- | ------------------- | ------------------------- |
| Aller à la position favorite | `favorite_position` | moteur                    |
| Avancer d'un pas             | `jog`               | moteur, haut ou bas       |
| Orienter les lames           | `set_tilt`          | moteur, angle de 0 à 180° |
| Bouger tous les stores       | `move_all`          | ouvrir, fermer ou arrêter |

`move_all` donne deux résultats aux actions suivantes : `sent` (moteurs atteints) et
`failed` (moteurs sans réponse).

Pour ouvrir, fermer ou positionner un seul moteur, utilisez l'action standard de
Gladys « Contrôler des appareils » sur son état ou sa position.

## Widget « Dooya Connector »

Ajoutez-le à un tableau de bord : il montre la position des quatre premiers moteurs
(en direct), l'état de la passerelle (connectée ou non, nombre de moteurs, signal
Wi-Fi, firmware), les moteurs dont la batterie est faible, et trois boutons :
**Tout ouvrir**, **Tout fermer** (demande une confirmation) et **Tout arrêter**.

## Bon à savoir

- La passerelle compte les positions depuis le haut (0 = ouvert) ; Gladys depuis le bas
  (100 = ouvert). L'intégration fait la conversion : vous ne voyez que le sens de
  Gladys.
- La position favorite est celle enregistrée dans le moteur (avec sa télécommande ou
  l'application).
- L'intégration lit la mémoire de la passerelle : un moteur qui a perdu sa liaison radio
  avec elle garde son dernier état connu.

## Dépannage

| Symptôme                                       | À vérifier                                                                                                                |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| « Aucune réponse de … sur le port UDP 32100 »  | L'adresse IP, que la passerelle est alimentée, sur le même réseau que Gladys, et qu'aucun pare-feu ne bloque l'UDP 32100. |
| « La clé doit faire exactement 16 caractères » | Recopiez la clé, tirets compris, sans espaces.                                                                            |
| « La passerelle répond mais refuse la clé »    | La clé est celle d'une autre passerelle ou a été mal saisie : recopiez-la depuis l'application.                           |
| Aucun moteur dans l'onglet Découverte          | Les moteurs doivent d'abord être appairés dans l'application Connector.                                                   |
| La position ne bouge pas                       | Les moteurs unidirectionnels ne la remontent pas ; pour les autres, vérifiez le moteur dans l'application Connector.      |
| « Chercher la passerelle » ne trouve rien      | Normal pour certaines passerelles : saisissez l'adresse lue dans votre box.                                               |

Les journaux de l'intégration, dans Gladys, indiquent quand la passerelle ne répond
plus et pourquoi un ordre a échoué. La clé et les jetons n'y sont jamais écrits.
